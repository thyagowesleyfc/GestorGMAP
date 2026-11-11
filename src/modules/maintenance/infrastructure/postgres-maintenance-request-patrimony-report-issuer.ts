import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import type {
  IssueMaintenanceRequestPatrimonyReportCommand,
  IssueMaintenanceRequestPatrimonyReportFailureReason,
  IssueMaintenanceRequestPatrimonyReportResult,
  MaintenanceRequestPatrimonyReportConclusion,
  MaintenanceRequestPatrimonyReportIssuer
} from "../application/issue-maintenance-request-patrimony-report";

type IdempotencyRow = {
  request_hash: string;
  status: "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  result_json: unknown;
};

type IdempotencyReservation =
  | { kind: "NEW"; id: string }
  | { kind: "REPLAY"; result: IssueMaintenanceRequestPatrimonyReportResult }
  | { kind: "CONFLICT" };

type MaintenanceRequestRow = {
  id: string;
  status: string;
  version: number;
  authorized_at: Date | null;
  authorized_by_user_id: string | null;
  authorization_reason: string | null;
};

type TargetRow = {
  patrimony_id: string;
  gre_code: string;
};

type LatestReportRow = {
  id: string;
  version: number;
  conclusion: MaintenanceRequestPatrimonyReportConclusion;
  justification: string;
  issued_at: Date;
  issued_by_user_id: string;
  correlation_id: string;
};

const ISSUE_MAINTENANCE_REQUEST_PATRIMONY_REPORT_COMMAND = "maintenance.issue_patrimony_report";
const MAINTENANCE_REQUEST_PATRIMONY_REPORT_ISSUED_EVENT =
  "maintenance.request_patrimony_report_issued";
const AUTHORIZED_TEAM_NAMES = ["Patrimônio"];

export class PostgresMaintenanceRequestPatrimonyReportIssuer implements MaintenanceRequestPatrimonyReportIssuer {
  constructor(private readonly pool: Pool) {}

  async issue(
    input: IssueMaintenanceRequestPatrimonyReportCommand
  ): Promise<IssueMaintenanceRequestPatrimonyReportResult> {
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

      const result = await this.issueInTransaction(client, input);
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
    input: IssueMaintenanceRequestPatrimonyReportCommand
  ): Promise<IdempotencyReservation> {
    const requestHash = hashIssueReportCommand(input);
    const idempotencyId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `insert into "command_idempotency" (
        "id", "command_name", "idempotency_key", "request_hash", "updated_at"
      ) values ($1, $2, $3, $4, current_timestamp)
      on conflict ("command_name", "idempotency_key") do nothing
      returning "id"`,
      [
        idempotencyId,
        ISSUE_MAINTENANCE_REQUEST_PATRIMONY_REPORT_COMMAND,
        input.commandId,
        requestHash
      ]
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
      [ISSUE_MAINTENANCE_REQUEST_PATRIMONY_REPORT_COMMAND, input.commandId]
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
    result: IssueMaintenanceRequestPatrimonyReportResult
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

  private async issueInTransaction(
    client: PoolClient,
    input: IssueMaintenanceRequestPatrimonyReportCommand
  ): Promise<IssueMaintenanceRequestPatrimonyReportResult> {
    const request = await client.query<MaintenanceRequestRow>(
      `select "id", "status"::text as "status", "version",
              "authorized_at", "authorized_by_user_id", "authorization_reason"
         from "maintenance_request"
        where "id" = $1
        for update`,
      [input.maintenanceRequestId]
    );
    const requestRow = request.rows[0];

    if (requestRow === undefined) {
      return {
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_FOUND",
        maintenanceRequestId: input.maintenanceRequestId,
        patrimonyId: input.patrimonyId
      };
    }
    if (
      requestRow.status !== "EM_ANALISE" ||
      requestRow.authorized_at === null ||
      requestRow.authorized_by_user_id === null ||
      requestRow.authorization_reason === null
    ) {
      return {
        ok: false,
        reason: "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
        maintenanceRequestId: input.maintenanceRequestId,
        patrimonyId: input.patrimonyId
      };
    }

    const target = await client.query<TargetRow>(
      `select t."patrimony_id", g."code" as "gre_code"
         from "maintenance_request_patrimony_target" t
         join "patrimony" p on p."id" = t."patrimony_id"
         join "entity" e on e."id" = p."responsible_entity_id"
         join "gre" g on g."id" = e."gre_id"
        where t."maintenance_request_id" = $1
          and t."patrimony_id" = $2
        for share of t, p`,
      [input.maintenanceRequestId, input.patrimonyId]
    );
    const targetRow = target.rows[0];

    if (targetRow === undefined) {
      return {
        ok: false,
        reason: "PATRIMONY_TARGET_NOT_LINKED",
        maintenanceRequestId: input.maintenanceRequestId,
        patrimonyId: input.patrimonyId
      };
    }

    if (!(await this.isAuthorized(client, input.actorUserId, targetRow.gre_code))) {
      return { ok: false, reason: "ACTOR_NOT_AUTHORIZED", patrimonyId: input.patrimonyId };
    }

    const strategy = await client.query(
      `select 1
         from "maintenance_request_patrimony_strategy"
        where "maintenance_request_id" = $1
          and "patrimony_id" = $2
        for share`,
      [input.maintenanceRequestId, input.patrimonyId]
    );
    if (strategy.rows.length === 0) {
      return {
        ok: false,
        reason: "PATRIMONY_STRATEGY_NOT_DEFINED",
        patrimonyId: input.patrimonyId
      };
    }

    const latestReport = await client.query<LatestReportRow>(
      `select "id", "version", "conclusion"::text as "conclusion", "justification",
              "issued_at", "issued_by_user_id", "correlation_id"
         from "maintenance_request_patrimony_report"
        where "maintenance_request_id" = $1
          and "patrimony_id" = $2
        order by "version" desc
        limit 1
        for share`,
      [input.maintenanceRequestId, input.patrimonyId]
    );
    const previousReport = latestReport.rows[0];
    const version = (previousReport?.version ?? 0) + 1;
    const reportId = randomUUID();

    await client.query(
      `insert into "maintenance_request_patrimony_report" (
        "id", "maintenance_request_id", "patrimony_id", "version", "conclusion",
        "justification", "issued_at", "issued_by_user_id", "correlation_id", "updated_at"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, current_timestamp)`,
      [
        reportId,
        input.maintenanceRequestId,
        input.patrimonyId,
        version,
        input.conclusion,
        input.justification,
        input.issuedAt,
        input.actorUserId,
        input.correlationId
      ]
    );

    await client.query(
      `update "maintenance_request"
          set "version" = "version" + 1,
              "updated_at" = current_timestamp
        where "id" = $1`,
      [input.maintenanceRequestId]
    );

    await client.query(
      `insert into "audit_entry" (
        "id", "occurred_at", "actor_user_id", "team_context", "action", "object_type", "object_id",
        "previous_value", "next_value", "correlation_id"
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [
        randomUUID(),
        input.issuedAt,
        input.actorUserId,
        input.teamContext,
        ISSUE_MAINTENANCE_REQUEST_PATRIMONY_REPORT_COMMAND,
        "maintenance_request_patrimony_report",
        reportId,
        JSON.stringify({
          maintenanceRequestId: input.maintenanceRequestId,
          patrimonyId: input.patrimonyId,
          version: previousReport?.version ?? null,
          conclusion: previousReport?.conclusion ?? null,
          justification: previousReport?.justification ?? null,
          issuedAt: previousReport?.issued_at ?? null,
          issuedByUserId: previousReport?.issued_by_user_id ?? null,
          correlationId: previousReport?.correlation_id ?? null
        }),
        JSON.stringify({
          maintenanceRequestId: input.maintenanceRequestId,
          patrimonyId: input.patrimonyId,
          version,
          conclusion: input.conclusion,
          justification: input.justification,
          issuedAt: input.issuedAt,
          issuedByUserId: input.actorUserId,
          correlationId: input.correlationId
        }),
        input.correlationId
      ]
    );

    await client.query(
      `insert into "outbox_event" (
        "id", "event_type", "aggregate_type", "aggregate_id", "payload", "updated_at"
      ) values ($1, $2, $3, $4, $5::jsonb, current_timestamp)`,
      [
        randomUUID(),
        MAINTENANCE_REQUEST_PATRIMONY_REPORT_ISSUED_EVENT,
        "maintenance_request_patrimony_report",
        reportId,
        JSON.stringify({
          reportId,
          maintenanceRequestId: input.maintenanceRequestId,
          patrimonyId: input.patrimonyId,
          version,
          conclusion: input.conclusion,
          issuedAt: input.issuedAt,
          issuedByUserId: input.actorUserId,
          correlationId: input.correlationId
        })
      ]
    );

    return {
      ok: true,
      reportId,
      maintenanceRequestId: input.maintenanceRequestId,
      patrimonyId: input.patrimonyId,
      version,
      conclusion: input.conclusion,
      status: "EM_ANALISE"
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

function hashIssueReportCommand(input: IssueMaintenanceRequestPatrimonyReportCommand): string {
  const payload = {
    maintenanceRequestId: input.maintenanceRequestId,
    patrimonyId: input.patrimonyId,
    conclusion: input.conclusion,
    justification: input.justification,
    issuedAt: input.issuedAt.toISOString(),
    actorUserId: input.actorUserId
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseStoredResult(value: unknown): IssueMaintenanceRequestPatrimonyReportResult {
  if (isIssueReportResult(value)) {
    return value;
  }
  throw new Error("Stored idempotency result is invalid.");
}

function isIssueReportResult(
  value: unknown
): value is IssueMaintenanceRequestPatrimonyReportResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  if (value.ok === true) {
    return (
      typeof (value as { reportId?: unknown }).reportId === "string" &&
      typeof (value as { maintenanceRequestId?: unknown }).maintenanceRequestId === "string" &&
      typeof (value as { patrimonyId?: unknown }).patrimonyId === "string" &&
      typeof (value as { version?: unknown }).version === "number" &&
      (value as { status?: unknown }).status === "EM_ANALISE"
    );
  }

  return isFailureReason((value as { reason?: unknown }).reason);
}

function isFailureReason(
  value: unknown
): value is IssueMaintenanceRequestPatrimonyReportFailureReason {
  return (
    typeof value === "string" &&
    new Set([
      "INVALID_COMMAND_ID",
      "INVALID_MAINTENANCE_REQUEST_ID",
      "INVALID_PATRIMONY_ID",
      "INVALID_CONCLUSION",
      "INVALID_JUSTIFICATION",
      "INVALID_ISSUED_AT",
      "INVALID_ACTOR_USER_ID",
      "INVALID_TEAM_CONTEXT",
      "IDEMPOTENCY_KEY_CONFLICT",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      "MAINTENANCE_REQUEST_NOT_AUTHORIZED",
      "PATRIMONY_TARGET_NOT_LINKED",
      "PATRIMONY_STRATEGY_NOT_DEFINED",
      "ACTOR_NOT_AUTHORIZED"
    ]).has(value)
  );
}
