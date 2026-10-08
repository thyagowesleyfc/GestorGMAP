import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  LogisticsDeliveryDocumentRegistrar,
  RegisterLogisticsDeliveryDocumentCommand,
  RegisterLogisticsDeliveryDocumentResult
} from "../application/register-logistics-delivery-document";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: RegisterLogisticsDeliveryDocumentResult }
  | { kind: "CONFLICT" };

type DeliveryRow = {
  id: string;
};

const UNIQUE_VIOLATION = "23505";
const REGISTER_LOGISTICS_DELIVERY_DOCUMENT_COMMAND = "logistics.register_delivery_document";

export class PostgresLogisticsDeliveryDocumentRegistrar implements LogisticsDeliveryDocumentRegistrar {
  constructor(private readonly pool: Pool) {}

  async register(
    input: RegisterLogisticsDeliveryDocumentCommand
  ): Promise<RegisterLogisticsDeliveryDocumentResult> {
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
        return { ok: false, reason: "IDEMPOTENCY_KEY_CONFLICT", deliveryId: input.deliveryId };
      }

      const result = await this.registerInTransaction(client, input);
      await this.storeIdempotencyResult(client, reservation.id, result);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);

      if (isPgError(error) && error.code === UNIQUE_VIOLATION) {
        if (error.constraint === "logistics_delivery_document_storage_key_key") {
          return { ok: false, reason: "DUPLICATE_STORAGE_KEY", deliveryId: input.deliveryId };
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveIdempotency(
    client: PoolClient,
    input: RegisterLogisticsDeliveryDocumentCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashRegisterLogisticsDeliveryDocumentCommand(input);
    const idempotencyId = randomUUID();

    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [idempotencyId, REGISTER_LOGISTICS_DELIVERY_DOCUMENT_COMMAND, input.commandId, requestHash]
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
      [REGISTER_LOGISTICS_DELIVERY_DOCUMENT_COMMAND, input.commandId]
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
    result: RegisterLogisticsDeliveryDocumentResult
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

  private async registerInTransaction(
    client: PoolClient,
    input: RegisterLogisticsDeliveryDocumentCommand
  ): Promise<RegisterLogisticsDeliveryDocumentResult> {
    const delivery = await client.query<DeliveryRow>(
      `select "id"
         from "logistics_delivery"
        where "id" = $1
        for update`,
      [input.deliveryId]
    );

    if (delivery.rows[0] === undefined) {
      return { ok: false, reason: "DELIVERY_NOT_FOUND", deliveryId: input.deliveryId };
    }

    const documentId = randomUUID();

    await client.query(
      `insert into "logistics_delivery_document" (
        "id", "delivery_id", "document_type", "document_number", "document_date", "issuer_name",
        "file_name", "content_type", "size_bytes", "storage_key", "sha256", "uploaded_by_user_id",
        "notes", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, current_timestamp)`,
      [
        documentId,
        input.deliveryId,
        input.documentType,
        input.documentNumber ?? null,
        input.documentDate ?? null,
        input.issuerName ?? null,
        input.file?.fileName ?? null,
        input.file?.contentType ?? null,
        input.file?.sizeBytes ?? null,
        input.file?.storageKey ?? null,
        input.file?.sha256 ?? null,
        input.file?.uploadedByUserId ?? null,
        input.notes ?? null
      ]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "reason", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
      [
        randomUUID(),
        input.documentDate ?? new Date(),
        input.actorUserId ?? null,
        input.teamContext ?? null,
        REGISTER_LOGISTICS_DELIVERY_DOCUMENT_COMMAND,
        "logistics_delivery_document",
        documentId,
        JSON.stringify({ deliveryId: input.deliveryId }),
        JSON.stringify({
          documentType: input.documentType,
          documentNumber: input.documentNumber ?? null,
          hasFile: input.file !== undefined
        }),
        input.notes ?? "Documento de entrega registrado.",
        input.correlationId
      ]
    );

    return {
      ok: true,
      documentId,
      deliveryId: input.deliveryId,
      documentType: input.documentType
    };
  }
}

function hashRegisterLogisticsDeliveryDocumentCommand(
  input: RegisterLogisticsDeliveryDocumentCommand
): string {
  const payload = {
    deliveryId: input.deliveryId,
    documentType: input.documentType,
    documentNumber: input.documentNumber,
    documentDate: input.documentDate?.toISOString(),
    issuerName: input.issuerName,
    file: input.file,
    notes: input.notes
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): RegisterLogisticsDeliveryDocumentResult {
  if (isRegisterLogisticsDeliveryDocumentResult(value)) {
    return value;
  }

  throw new Error("Stored idempotency result is invalid.");
}

function isRegisterLogisticsDeliveryDocumentResult(
  value: unknown
): value is RegisterLogisticsDeliveryDocumentResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (value.ok === true) {
    return typeof (value as { documentId?: unknown }).documentId === "string";
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
