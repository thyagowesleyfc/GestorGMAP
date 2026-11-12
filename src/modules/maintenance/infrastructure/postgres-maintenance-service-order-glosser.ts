import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  GlosaMaintenanceServiceOrderCommand,
  GlosaMaintenanceServiceOrderFailureReason,
  GlosaMaintenanceServiceOrderResult,
  MaintenanceServiceOrderGlosser
} from "../application/glosa-maintenance-service-order";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: GlosaMaintenanceServiceOrderResult }
  | { kind: "CONFLICT" };

type ServiceOrderRow = {
  id: string;
  code: string;
  contract_id: string;
  status: string;
};

type TargetGreRow = {
  gre_code: string;
};

type ServiceLineRow = {
  id: string;
  line_number: number;
  contract_item_id: string;
  quantity: number;
  unit_price: string;
  glosed_quantity: number;
  glosed_amount: string;
};

type ContractBalanceRow = {
  contract_item_id: string;
  contract_id: string;
  committed_quantity: number;
  committed_amount: string;
};

const GLOSA_MAINTENANCE_SERVICE_ORDER_COMMAND = "maintenance.glosa_service_order";
const MAINTENANCE_SERVICE_ORDER_GLOSSED_EVENT = "maintenance.service_order_glossed";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio"];

export class PostgresMaintenanceServiceOrderGlosser implements MaintenanceServiceOrderGlosser {
  constructor(private readonly pool: Pool) {}

  async glosa(
    input: GlosaMaintenanceServiceOrderCommand
  ): Promise<GlosaMaintenanceServiceOrderResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      const reservation = await this.reserveIdempotency(client, input);
      if (reservation.kind === "REPLAY") {
        await client.query("commit");
        return reservation.result;
      }
      if (reservation.kind === "CONFLICT") {
        await client.query("commit");
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" };
      }

      const result = await this.glosaInTransaction(client, input);
      await this.storeIdempotencyResult(client, reservation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: GlosaMaintenanceServiceOrderCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashGlosaCommand(input);
    const idempotencyId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, GLOSA_MAINTENANCE_SERVICE_ORDER_COMMAND, input.commandId, requestHash]
    );

    if (inserted.rows.length === 1) {
      return { kind: "NEW", id: inserted.rows[0].id };
    }

    const existing = await client.query<IdempotencyRow>(
      `select "request_hash", "status", "result_json"
         from "command_idempotency"
        where "command_name" = $1
          and "idempotency_key" = $2
        for update`,
      [GLOSA_MAINTENANCE_SERVICE_ORDER_COMMAND, input.commandId]
    );
    const row = existing.rows[0];

    if (row === undefined || row.request_hash !== requestHash) {
      return { kind: "CONFLICT" };
    }
    if (row.status === "SUCCEEDED" && row.result_json !== null) {
      return { kind: "REPLAY", result: parseStoredResult(row.result_json) };
    }

    return { kind: "CONFLICT" };
  }

  private async storeIdempotencyResult(
    client: PoolClient,
    idempotencyId: string,
    result: GlosaMaintenanceServiceOrderResult
  ): Promise<void> {
    await client.query(
      `update "command_idempotency"
          set "status" = 'SUCCEEDED',
              "result_json" = $2::jsonb,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [idempotencyId, JSON.stringify(result)]
    );
  }

  private async glosaInTransaction(
    client: PoolClient,
    input: GlosaMaintenanceServiceOrderCommand
  ): Promise<GlosaMaintenanceServiceOrderResult> {
    const serviceOrder = await client.query<ServiceOrderRow>(
      `select "id", "code", "contract_id", "status"::text as "status"
         from "maintenance_service_order"
        where "id" = $1
        for update`,
      [input.serviceOrderId]
    );
    const serviceOrderRow = serviceOrder.rows[0];

    if (serviceOrderRow === undefined) {
      return {
        ok: false,
        reason: "SERVICE_ORDER_NOT_FOUND",
        serviceOrderId: input.serviceOrderId
      };
    }
    if (serviceOrderRow.status !== "EXECUTADA" && serviceOrderRow.status !== "ATESTADA") {
      return {
        ok: false,
        reason: "SERVICE_ORDER_NOT_GLOSSABLE",
        serviceOrderId: input.serviceOrderId
      };
    }

    const confirmation = await client.query<{ id: string }>(
      `select "id"
         from "maintenance_service_order_entity_confirmation"
        where "service_order_id" = $1`,
      [input.serviceOrderId]
    );
    if (confirmation.rows.length === 0) {
      return {
        ok: false,
        reason: "SERVICE_ORDER_WITHOUT_ENTITY_CONFIRMATION",
        serviceOrderId: input.serviceOrderId
      };
    }

    const targets = await client.query<TargetGreRow>(
      `select g."code" as "gre_code"
         from "maintenance_service_order_patrimony" sop
         join "patrimony" p on p."id" = sop."patrimony_id"
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where sop."service_order_id" = $1
        for share of sop, p`,
      [input.serviceOrderId]
    );
    const greCodes = [...new Set(targets.rows.map((target) => target.gre_code))];

    if (greCodes.length === 0) {
      return {
        ok: false,
        reason: "SERVICE_ORDER_WITHOUT_PATRIMONY_TARGET",
        serviceOrderId: input.serviceOrderId
      };
    }

    for (const greCode of greCodes) {
      if (!(await this.isAuthorized(client, input.actorUserId, greCode))) {
        return {
          ok: false,
          reason: "ACTOR_NOT_AUTHORIZED",
          serviceOrderId: input.serviceOrderId
        };
      }
    }

    const serviceLines = await client.query<ServiceLineRow>(
      `select "id", "line_number", "contract_item_id", "quantity",
              "unit_price"::text as "unit_price", "glosed_quantity",
              "glosed_amount"::text as "glosed_amount"
         from "maintenance_service_order_service"
        where "service_order_id" = $1
        order by "id"
        for update`,
      [input.serviceOrderId]
    );
    const serviceLinesById = new Map(serviceLines.rows.map((line) => [line.id, line]));
    const requestedLines = input.lines.map((line) => {
      const serviceLine = serviceLinesById.get(line.serviceOrderServiceId);
      return { input: line, serviceLine };
    });

    for (const requestedLine of requestedLines) {
      if (requestedLine.serviceLine === undefined) {
        return {
          ok: false,
          reason: "SERVICE_ORDER_LINE_NOT_FOUND",
          serviceOrderId: input.serviceOrderId,
          serviceOrderServiceId: requestedLine.input.serviceOrderServiceId
        };
      }
      if (requestedLine.serviceLine.glosed_quantity > 0) {
        return {
          ok: false,
          reason: "SERVICE_ORDER_LINE_ALREADY_GLOSSED",
          serviceOrderId: input.serviceOrderId,
          serviceOrderServiceId: requestedLine.input.serviceOrderServiceId
        };
      }
      if (requestedLine.input.quantity > requestedLine.serviceLine.quantity) {
        return {
          ok: false,
          reason: "GLOSA_QUANTITY_EXCEEDS_COMMITTED",
          serviceOrderId: input.serviceOrderId,
          serviceOrderServiceId: requestedLine.input.serviceOrderServiceId
        };
      }
    }

    const contractItemIds = [
      ...new Set(requestedLines.map((line) => line.serviceLine?.contract_item_id).filter(isString))
    ].sort();
    const balances = await client.query<ContractBalanceRow>(
      `select cbp."contract_item_id", ci."contract_id", cbp."committed_quantity",
              cbp."committed_amount"::text as "committed_amount"
         from "contract_balance_position" cbp
         join "contract_item" ci on ci."id" = cbp."contract_item_id"
        where cbp."contract_item_id" = any($1::uuid[])
        order by cbp."contract_item_id"
        for update of cbp, ci`,
      [contractItemIds]
    );
    const balancesByItem = new Map(
      balances.rows.map((balance) => [balance.contract_item_id, balance])
    );

    const requestedByItem = new Map<string, { quantity: number; amountCents: bigint }>();
    for (const requestedLine of requestedLines) {
      if (requestedLine.serviceLine === undefined) {
        continue;
      }
      const amountCents =
        decimalToCents(requestedLine.serviceLine.unit_price) * BigInt(requestedLine.input.quantity);
      const current = requestedByItem.get(requestedLine.serviceLine.contract_item_id);
      requestedByItem.set(requestedLine.serviceLine.contract_item_id, {
        quantity: (current?.quantity ?? 0) + requestedLine.input.quantity,
        amountCents: (current?.amountCents ?? 0n) + amountCents
      });
    }

    for (const contractItemId of contractItemIds) {
      const balance = balancesByItem.get(contractItemId);
      const requested = requestedByItem.get(contractItemId);
      if (balance === undefined || requested === undefined) {
        return {
          ok: false,
          reason: "CONTRACT_ITEM_BALANCE_NOT_FOUND",
          serviceOrderId: input.serviceOrderId
        };
      }
      if (balance.contract_id !== serviceOrderRow.contract_id) {
        return {
          ok: false,
          reason: "CONTRACT_ITEM_CONTRACT_MISMATCH",
          serviceOrderId: input.serviceOrderId
        };
      }
      if (
        balance.committed_quantity < requested.quantity ||
        decimalToCents(balance.committed_amount) < requested.amountCents
      ) {
        return {
          ok: false,
          reason: "INSUFFICIENT_COMMITTED_CONTRACT_BALANCE",
          serviceOrderId: input.serviceOrderId
        };
      }
    }

    let totalGlosaCents = 0n;
    for (const requestedLine of requestedLines) {
      const serviceLine = requestedLine.serviceLine;
      if (serviceLine === undefined) {
        continue;
      }
      const amount = centsToDecimal(
        decimalToCents(serviceLine.unit_price) * BigInt(requestedLine.input.quantity)
      );
      totalGlosaCents += decimalToCents(amount);

      await client.query(
        `update "maintenance_service_order_service"
            set "glosed_quantity" = "glosed_quantity" + $2,
                "glosed_amount" = "glosed_amount" + $3,
                "updated_at" = current_timestamp
          where "id" = $1`,
        [serviceLine.id, requestedLine.input.quantity, amount]
      );

      await client.query(
        `update "contract_balance_position"
            set "committed_quantity" = "committed_quantity" - $2,
                "available_quantity" = "available_quantity" + $2,
                "committed_amount" = "committed_amount" - $3,
                "available_amount" = "available_amount" + $3,
                "version" = "version" + 1,
                "updated_at" = current_timestamp
          where "contract_item_id" = $1`,
        [serviceLine.contract_item_id, requestedLine.input.quantity, amount]
      );

      await client.query(
        `insert into "contract_balance_movement" (
          "id", "code", "contract_item_id", "maintenance_service_order_service_id",
          "type", "quantity_delta", "amount_delta", "occurred_at", "summary"
        ) values ($1, $2, $3, $4, 'GLOSA_OS', $5, $6, $7, $8)`,
        [
          randomUUID(),
          `${serviceOrderRow.code}-OS-GL-${serviceLine.line_number.toString().padStart(3, "0")}`,
          serviceLine.contract_item_id,
          serviceLine.id,
          requestedLine.input.quantity,
          amount,
          input.glosaAt,
          `Restituição por glosa da OS ${serviceOrderRow.code}, linha ${serviceLine.line_number}`
        ]
      );
    }

    const requestedByLineId = new Map(
      requestedLines.map((line) => [line.input.serviceOrderServiceId, line.input.quantity])
    );
    const isTotalGlosa = serviceLines.rows.every(
      (line) => line.glosed_quantity + (requestedByLineId.get(line.id) ?? 0) === line.quantity
    );
    const status = isTotalGlosa ? "CONCLUIDA_COM_GLOSA_TOTAL" : "CONCLUIDA_COM_GLOSA_PARCIAL";
    await client.query(
      `update "maintenance_service_order"
          set "status" = $2,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.serviceOrderId, status]
    );

    const previousValue = { status: serviceOrderRow.status };
    const nextValue = {
      status,
      glosaAt: input.glosaAt,
      glosaByUserId: input.actorUserId,
      lines: requestedLines.map((line) => ({
        serviceOrderServiceId: line.input.serviceOrderServiceId,
        quantity: line.input.quantity
      })),
      totalGlosaAmount: centsToDecimal(totalGlosaCents),
      correlationId: input.correlationId
    };
    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        randomUUID(),
        input.glosaAt,
        input.actorUserId,
        input.teamContext,
        GLOSA_MAINTENANCE_SERVICE_ORDER_COMMAND,
        "maintenance_service_order",
        input.serviceOrderId,
        JSON.stringify(previousValue),
        JSON.stringify(nextValue),
        input.correlationId
      ]
    );

    await client.query(
      `insert into "outbox_event" (
        "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
      ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
      [
        randomUUID(),
        MAINTENANCE_SERVICE_ORDER_GLOSSED_EVENT,
        "maintenance_service_order",
        input.serviceOrderId,
        JSON.stringify({
          serviceOrderId: input.serviceOrderId,
          status,
          glosaAt: input.glosaAt,
          glosaByUserId: input.actorUserId,
          lines: nextValue.lines,
          totalGlosaAmount: nextValue.totalGlosaAmount,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      serviceOrderId: input.serviceOrderId,
      status,
      totalGlosaAmount: centsToDecimal(totalGlosaCents)
    };
  }

  private async isAuthorized(
    client: PoolClient,
    actorUserId: string,
    greCode: string
  ): Promise<boolean> {
    const authorization = await client.query<{ authorized: boolean }>(
      `select exists(
         select 1
           from "user_account" u
           join "team_membership" tm on tm."user_id" = u."id"
           join "team" t on t."id" = tm."team_id"
          where u."id" = $1
            and u."status" = 'ACTIVE'
            and tm."active" = true
            and t."name" = any($2::varchar[])
            and (
              tm."scope_type" = 'GLOBAL'
              or (tm."scope_type" = 'GRE' and tm."gre_code" = $3)
            )
       ) as "authorized"`,
      [actorUserId, AUTHORIZED_TEAM_NAMES, greCode]
    );

    return authorization.rows[0]?.authorized === true;
  }
}

function hashGlosaCommand(input: GlosaMaintenanceServiceOrderCommand): string {
  const payload = {
    serviceOrderId: input.serviceOrderId,
    lines: input.lines,
    glosaAt: input.glosaAt.toISOString(),
    actorUserId: input.actorUserId,
    teamContext: input.teamContext
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): GlosaMaintenanceServiceOrderResult {
  if (isGlosaResult(value)) {
    return value;
  }
  throw new Error("Stored service order glosa idempotency result is invalid.");
}

function isGlosaResult(value: unknown): value is GlosaMaintenanceServiceOrderResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if (value.ok === true) {
    const result = value as {
      serviceOrderId?: unknown;
      status?: unknown;
      totalGlosaAmount?: unknown;
    };
    return (
      typeof result.serviceOrderId === "string" &&
      (result.status === "CONCLUIDA_COM_GLOSA_PARCIAL" ||
        result.status === "CONCLUIDA_COM_GLOSA_TOTAL") &&
      typeof result.totalGlosaAmount === "string"
    );
  }

  return isFailureReason((value as { reason?: unknown }).reason);
}

function isFailureReason(value: unknown): value is GlosaMaintenanceServiceOrderFailureReason {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_SERVICE_ORDER_ID",
      "EMPTY_GLOSA_LINES",
      "INVALID_SERVICE_ORDER_LINE_ID",
      "DUPLICATE_SERVICE_ORDER_LINE",
      "INVALID_GLOSA_QUANTITY",
      "INVALID_GLOSA_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "SERVICE_ORDER_NOT_FOUND",
      "SERVICE_ORDER_NOT_GLOSSABLE",
      "SERVICE_ORDER_WITHOUT_ENTITY_CONFIRMATION",
      "SERVICE_ORDER_WITHOUT_PATRIMONY_TARGET",
      "SERVICE_ORDER_LINE_NOT_FOUND",
      "SERVICE_ORDER_LINE_ALREADY_GLOSSED",
      "GLOSA_QUANTITY_EXCEEDS_COMMITTED",
      "CONTRACT_ITEM_BALANCE_NOT_FOUND",
      "CONTRACT_ITEM_CONTRACT_MISMATCH",
      "INSUFFICIENT_COMMITTED_CONTRACT_BALANCE",
      "ACTOR_NOT_AUTHORIZED"
    ]).has(value)
  );
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function decimalToCents(value: string): bigint {
  const sign = value.startsWith("-") ? -1n : 1n;
  const unsignedValue = value.replace(/^-/, "");
  const [units, fraction = ""] = unsignedValue.split(".");
  const cents = `${fraction}00`.slice(0, 2);

  return sign * (BigInt(units) * 100n + BigInt(cents));
}

function centsToDecimal(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absoluteValue = value < 0n ? -value : value;
  const units = absoluteValue / 100n;
  const cents = (absoluteValue % 100n).toString().padStart(2, "0");

  return `${sign}${units.toString()}.${cents}`;
}
