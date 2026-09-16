import { logStructured, type LogFields, type LogLevel } from "../../../shared/observability/logger";

export type IamSecurityAuditEvent =
  | "iam.login.rejected"
  | "iam.login.rate_limited"
  | "iam.login.failed"
  | "iam.login.succeeded"
  | "iam.logout.succeeded"
  | "iam.session.revoked"
  | "iam.password_recovery.request_rejected"
  | "iam.password_recovery.request_rate_limited"
  | "iam.password_recovery.request_accepted"
  | "iam.password_recovery.reset_rejected"
  | "iam.password_recovery.reset_rate_limited"
  | "iam.password_recovery.reset_failed"
  | "iam.password_recovery.reset_succeeded";

export type IamSecurityAuditLogger = {
  log(event: IamSecurityAuditEvent, fields?: LogFields): void;
};

const eventMetadata: Record<IamSecurityAuditEvent, { level: LogLevel; message: string }> = {
  "iam.login.rejected": {
    level: "warn",
    message: "Login request rejected."
  },
  "iam.login.rate_limited": {
    level: "warn",
    message: "Login rate limit reached."
  },
  "iam.login.failed": {
    level: "warn",
    message: "Login failed."
  },
  "iam.login.succeeded": {
    level: "info",
    message: "Login succeeded."
  },
  "iam.logout.succeeded": {
    level: "info",
    message: "Logout succeeded."
  },
  "iam.session.revoked": {
    level: "info",
    message: "Session revoked."
  },
  "iam.password_recovery.request_rejected": {
    level: "warn",
    message: "Password recovery request rejected."
  },
  "iam.password_recovery.request_rate_limited": {
    level: "warn",
    message: "Password recovery request rate limit reached."
  },
  "iam.password_recovery.request_accepted": {
    level: "info",
    message: "Password recovery request accepted."
  },
  "iam.password_recovery.reset_rejected": {
    level: "warn",
    message: "Password recovery reset rejected."
  },
  "iam.password_recovery.reset_rate_limited": {
    level: "warn",
    message: "Password recovery reset rate limit reached."
  },
  "iam.password_recovery.reset_failed": {
    level: "warn",
    message: "Password recovery reset failed."
  },
  "iam.password_recovery.reset_succeeded": {
    level: "info",
    message: "Password recovery reset succeeded."
  }
};

export function logIamSecurityAuditEvent(
  event: IamSecurityAuditEvent,
  fields: LogFields = {},
  now = new Date()
): void {
  const metadata = eventMetadata[event];

  logStructured(metadata.level, event, metadata.message, fields, now);
}

export function createIamSecurityAuditLogger(
  correlationId: string,
  now?: () => Date
): IamSecurityAuditLogger {
  return {
    log(event, fields = {}) {
      logIamSecurityAuditEvent(
        event,
        {
          ...fields,
          correlation_id: correlationId
        },
        now?.() ?? new Date()
      );
    }
  };
}
