import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  FinalizeMaterialRequestCommand,
  FinalizeMaterialRequestResult,
  MaterialRequestFinalizer
} from "../application/finalize-material-request";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: FinalizeMaterialRequestResult }
  | { kind: "CONFLICT" };

type MaterialRequestRow = {
  id: string;
  status: "TRIAGEM" | "NOVA" | "ANALISADA" | "DESPACHADA" | "FINALIZADA";
  version: number;
};

type ShipmentDeliveryRow = {
  shipment_id: string;
  delivery_id: string | null;
};

const FINALIZE_MATERIAL_REQUEST_COMMAND = "requests.finalize_material_request";

export class PostgresMaterialRequestFinalizer implements MaterialRequestFinalizer {
  constructor(private readonly pool: Pool) {}

  async finalize(input: FinalizeMaterialRequestCommand): Promise<FinalizeMaterialRequestResult> {
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

      const result = await this.finalizeInTransaction(client, input);
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
    input: FinalizeMaterialRequestCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashFinalizeMaterialRequestCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, FINALIZE_MATERIAL_REQUEST_COMMAND, input.commandId, requestHash]
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
      [FINALIZE_MATERIAL_REQUEST_COMMAND, input.commandId]
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
    result: FinalizeMaterialRequestResult
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

  private async finalizeInTransaction(
    client: PoolClient,
    input: FinalizeMaterialRequestCommand
  ): Promise<FinalizeMaterialRequestResult> {
    const request = await client.query<MaterialRequestRow>(
      `select "id", "status"::text as "status", "version"
         from "material_request"
        where "id" = $1
        for update`,
      [input.materialRequestId]
    );
    const requestRow = request.rows[0];

    if (requestRow === undefined) {
      return { ok: false, reason: "MATERIAL_REQUEST_NOT_FOUND" };
    }

    if (requestRow.status !== "DESPACHADA") {
      return { ok: false, reason: "MATERIAL_REQUEST_NOT_DISPATCHED" };
    }

    const shipments = await client.query<ShipmentDeliveryRow>(
      `select s."id" as "shipment_id", d."id" as "delivery_id"
         from "logistics_shipment" s
         left join "logistics_delivery" d on d."shipment_id" = s."id"
        where s."material_request_id" = $1
        order by s."id"
        for update of s`,
      [input.materialRequestId]
    );

    if (shipments.rows.length === 0) {
      return { ok: false, reason: "MATERIAL_REQUEST_NOT_SHIPPED" };
    }

    const missingDelivery = shipments.rows.find((row) => row.delivery_id === null);
    if (missingDelivery !== undefined) {
      return {
        ok: false,
        reason: "SHIPMENT_NOT_DELIVERED",
        shipmentId: missingDelivery.shipment_id
      };
    }

    if (await hasPendingPatrimonialEffects(client, input.materialRequestId)) {
      return { ok: false, reason: "PATRIMONIAL_EFFECTS_PENDING" };
    }

    await client.query(
      `update "material_request"
          set "status" = 'FINALIZADA',
              "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.materialRequestId]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.finalizedAt,
        input.actorUserId ?? null,
        input.teamContext ?? null,
        FINALIZE_MATERIAL_REQUEST_COMMAND,
        "material_request",
        input.materialRequestId,
        JSON.stringify({ status: requestRow.status, version: requestRow.version }),
        JSON.stringify({
          status: "FINALIZADA",
          version: requestRow.version + 1,
          shipmentCount: shipments.rows.length
        }),
        input.reason,
        input.correlationId
      ]
    );

    return { ok: true, materialRequestId: input.materialRequestId, status: "FINALIZADA" };
  }
}

async function hasPendingPatrimonialEffects(
  client: PoolClient,
  materialRequestId: string
): Promise<boolean> {
  const accepted = await client.query<{ has_accepted_delivery: boolean }>(
    `select exists(
       select 1
         from "logistics_shipment" s
         join "logistics_delivery" d on d."shipment_id" = s."id"
        where s."material_request_id" = $1
          and d."acceptance_status" in ('TOTAL', 'PARCIAL')
     ) as "has_accepted_delivery"`,
    [materialRequestId]
  );

  if (accepted.rows[0]?.has_accepted_delivery !== true) {
    return false;
  }

  const tombable = await client.query<{ has_tombable_item: boolean }>(
    `select exists(
       select 1
         from "material_request_item" i
         left join "material_singular" direct_material
           on direct_material."id" = i."material_singular_id"
         left join "material_configuration_component" component
           on component."configuration_id" = i."material_configuration_id"
         left join "material_singular" component_material
           on component_material."id" = component."material_singular_id"
        where i."material_request_id" = $1
          and (
            direct_material."is_tombable" = true
            or component_material."is_tombable" = true
          )
     ) as "has_tombable_item"`,
    [materialRequestId]
  );

  return tombable.rows[0]?.has_tombable_item === true;
}
function hashFinalizeMaterialRequestCommand(input: FinalizeMaterialRequestCommand): string {
  const payload = {
    materialRequestId: input.materialRequestId,
    reason: input.reason
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): FinalizeMaterialRequestResult {
  if (isFinalizeMaterialRequestResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isFinalizeMaterialRequestResult(value: unknown): value is FinalizeMaterialRequestResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { materialRequestId?: unknown }).materialRequestId === "string";
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}
