import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  RegularizeReceivingStockCommand,
  RegularizeReceivingStockResult,
  ReceivingStockRegularizer
} from "../application/regularize-receiving-stock";

type IdempotencyRow = {
  id: string;
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyRegularization =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RegularizeReceivingStockResult }
  | { kind: "CONFLICT" };

type LockedReceivingItem = {
  id: string;
  receiving_entity_id: string;
  material_singular_id: string | null;
  material_configuration_id: string | null;
  quantity: number;
};

type StockPositionRow = {
  id: string;
  physical_quantity: number;
  reserved_quantity: number;
  separating_quantity: number;
  available_quantity: number;
  version: number;
};

const UNIQUE_VIOLATION = "23505";
const REGULARIZE_RECEIVING_STOCK_COMMAND = "stock.regularize_receiving_stock";

export class PostgresReceivingStockRegularizer implements ReceivingStockRegularizer {
  constructor(private readonly pool: Pool) {}

  async regularize(
    input: RegularizeReceivingStockCommand
  ): Promise<RegularizeReceivingStockResult> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");

      const regularization = await this.reserveIdempotency(client, input);
      if (regularization.kind === "REPLAY") {
        await client.query("commit");
        return regularization.result;
      }

      if (regularization.kind === "CONFLICT") {
        await client.query("commit");
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT" };
      }

      const result = await this.regularizeInTransaction(client, input);
      await this.storeIdempotencyResult(client, regularization.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "receiving_entry_item_regularization_item_key") {
          return { ok: false, reason: "DUPLICATE_REGULARIZATION" };
        }

        if (error.constraint === "stock_movement_code_key") {
          return { ok: false, reason: "DUPLICATE_MOVEMENT_CODE" };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: RegularizeReceivingStockCommand
  ): Promise<IdempotencyRegularization> {
    const requestHash = hashRegularizeReceivingStockCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, REGULARIZE_RECEIVING_STOCK_COMMAND, input.commandId, requestHash]
    );

    if (inserted.rows.length === 1) {
      return { kind: "NEW", id: inserted.rows[0].id };
    }

    const existing = await client.query<IdempotencyRow>(
      `select "id", "request_hash", "status", "result_json"
         from "command_idempotency"
        where "command_name" = $1
          and "idempotency_key" = $2
        for update`,
      [REGULARIZE_RECEIVING_STOCK_COMMAND, input.commandId]
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
    result: RegularizeReceivingStockResult
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

  private async regularizeInTransaction(
    client: PoolClient,
    input: RegularizeReceivingStockCommand
  ): Promise<RegularizeReceivingStockResult> {
    const itemResult = await client.query<LockedReceivingItem>(
      `select rei."id",
              re."receiving_entity_id",
              rei."material_singular_id",
              rei."material_configuration_id",
              rei."quantity"
         from "receiving_entry_item" rei
         join "receiving_entry" re on re."id" = rei."receiving_entry_id"
        where rei."id" = $1
        for update of rei`,
      [input.receivingEntryItemId]
    );
    const item = itemResult.rows[0];

    if (item === undefined) {
      return {
        ok: false,
        reason: "RECEIVING_ENTRY_ITEM_NOT_FOUND",
        receivingEntryItemId: input.receivingEntryItemId
      };
    }

    const regularizationId = randomUUID();
    const movementId = randomUUID();

    await client.query(
      `insert into "receiving_entry_item_regularization" (
        "id", "receiving_entry_item_id", "origin_type", "regularized_at", "contract_id",
        "contract_item_id", "supply_order_id", "supply_order_item_id", "regularized_by_user_id", "notes", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, current_timestamp)`,
      [
        regularizationId,
        input.receivingEntryItemId,
        input.originType,
        input.regularizedAt,
        input.contractId ?? null,
        input.contractItemId ?? null,
        input.supplyOrderId ?? null,
        input.supplyOrderItemId ?? null,
        input.regularizedByUserId ?? null,
        input.notes ?? null
      ]
    );

    await client.query(
      `insert into "stock_movement" (
        "id", "code", "movement_type", "receiving_entry_item_regularization_id", "receiving_entry_item_id",
        "origin_type", "quantity_delta", "occurred_at", "summary"
      ) values ($1, $2, 'ENTRADA_RECEBIMENTO', $3, $4, $5, $6, $7, $8)`,
      [
        movementId,
        input.movementCode,
        regularizationId,
        input.receivingEntryItemId,
        input.originType,
        item.quantity,
        input.regularizedAt,
        input.summary
      ]
    );

    const positionBefore = await this.findStockPosition(client, item, input.originType);
    const stockPositionId = positionBefore?.id ?? randomUUID();
    const positionAfter = await this.upsertStockPosition(
      client,
      item,
      input.originType,
      stockPositionId
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.regularizedAt,
        input.actorUserId ?? input.regularizedByUserId ?? null,
        input.teamContext ?? null,
        REGULARIZE_RECEIVING_STOCK_COMMAND,
        "receiving_entry_item_regularization",
        regularizationId,
        JSON.stringify({
          receivingEntryItemId: input.receivingEntryItemId,
          stockPositionId: positionBefore?.id ?? null,
          physicalQuantity: positionBefore?.physical_quantity ?? 0,
          reservedQuantity: positionBefore?.reserved_quantity ?? 0,
          separatingQuantity: positionBefore?.separating_quantity ?? 0,
          availableQuantity: positionBefore?.available_quantity ?? 0,
          version: positionBefore?.version ?? 0
        }),
        JSON.stringify({
          receivingEntryItemId: input.receivingEntryItemId,
          regularizationId,
          movementId,
          stockPositionId,
          physicalQuantity: positionAfter.physical_quantity,
          reservedQuantity: positionAfter.reserved_quantity,
          separatingQuantity: positionAfter.separating_quantity,
          availableQuantity: positionAfter.available_quantity,
          version: positionAfter.version
        }),
        input.summary,
        input.correlationId
      ]
    );

    return { ok: true, regularizationId, movementId, stockPositionId };
  }

  private async findStockPosition(
    client: PoolClient,
    item: LockedReceivingItem,
    originType: RegularizeReceivingStockCommand["originType"]
  ): Promise<StockPositionRow | undefined> {
    const position = await client.query<StockPositionRow>(
      `select "id", "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "version"
         from "stock_position"
        where "stock_entity_id" = $1
          and "origin_type" = $2
          and (("material_singular_id" = $3 and $3::uuid is not null)
            or ("material_configuration_id" = $4 and $4::uuid is not null))
        for update`,
      [
        item.receiving_entity_id,
        originType,
        item.material_singular_id,
        item.material_configuration_id
      ]
    );

    return position.rows[0];
  }

  private async upsertStockPosition(
    client: PoolClient,
    item: LockedReceivingItem,
    originType: RegularizeReceivingStockCommand["originType"],
    stockPositionId: string
  ): Promise<StockPositionRow> {
    if (item.material_singular_id !== null) {
      const position = await client.query<StockPositionRow>(
        `insert into "stock_position" (
          "id", "stock_entity_id", "material_singular_id", "origin_type",
          "physical_quantity", "available_quantity", "updated_at"
        ) values ($1, $2, $3, $4, $5, $5, current_timestamp)
        on conflict ("stock_entity_id", "material_singular_id", "origin_type")
        where "material_singular_id" is not null
        do update set
          "physical_quantity" = "stock_position"."physical_quantity" + excluded."physical_quantity",
          "available_quantity" = "stock_position"."available_quantity" + excluded."available_quantity",
          "version" = "stock_position"."version" + 1,
          "updated_at" = current_timestamp
        returning "id", "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "version"`,
        [
          stockPositionId,
          item.receiving_entity_id,
          item.material_singular_id,
          originType,
          item.quantity
        ]
      );

      return position.rows[0];
    }

    const position = await client.query<StockPositionRow>(
      `insert into "stock_position" (
        "id", "stock_entity_id", "material_configuration_id", "origin_type",
        "physical_quantity", "available_quantity", "updated_at"
      ) values ($1, $2, $3, $4, $5, $5, current_timestamp)
      on conflict ("stock_entity_id", "material_configuration_id", "origin_type")
      where "material_configuration_id" is not null
      do update set
        "physical_quantity" = "stock_position"."physical_quantity" + excluded."physical_quantity",
        "available_quantity" = "stock_position"."available_quantity" + excluded."available_quantity",
        "version" = "stock_position"."version" + 1,
        "updated_at" = current_timestamp
      returning "id", "physical_quantity", "reserved_quantity", "separating_quantity", "available_quantity", "version"`,
      [
        stockPositionId,
        item.receiving_entity_id,
        item.material_configuration_id,
        originType,
        item.quantity
      ]
    );

    return position.rows[0];
  }
}

function hashRegularizeReceivingStockCommand(input: RegularizeReceivingStockCommand): string {
  const payload = {
    movementCode: input.movementCode,
    receivingEntryItemId: input.receivingEntryItemId,
    originType: input.originType,
    summary: input.summary,
    contractId: input.contractId,
    contractItemId: input.contractItemId,
    supplyOrderId: input.supplyOrderId,
    supplyOrderItemId: input.supplyOrderItemId,
    regularizedByUserId: input.regularizedByUserId,
    notes: input.notes
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RegularizeReceivingStockResult {
  if (isRegularizeReceivingStockResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRegularizeReceivingStockResult(value: unknown): value is RegularizeReceivingStockResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    const result = value as {
      regularizationId?: unknown;
      movementId?: unknown;
      stockPositionId?: unknown;
    };

    return (
      typeof result.regularizationId === "string" &&
      typeof result.movementId === "string" &&
      typeof result.stockPositionId === "string"
    );
  }

  return typeof (value as { reason?: unknown }).reason === "string";
}

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
