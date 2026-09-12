export type LogLevel = "info" | "warn" | "error";
export type LogFieldValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogFieldValue>;

const SERVICE_NAME = "gestor-gmap";

function removeUndefinedFields(
  fields: LogFields
): Record<string, Exclude<LogFieldValue, undefined>> {
  return Object.fromEntries(
    Object.entries(fields).filter((entry) => entry[1] !== undefined)
  ) as Record<string, Exclude<LogFieldValue, undefined>>;
}

function writeLog(level: LogLevel, payload: string): void {
  if (level === "error") {
    console.error(payload);
    return;
  }

  if (level === "warn") {
    console.warn(payload);
    return;
  }

  console.info(payload);
}

export function logStructured(
  level: LogLevel,
  event: string,
  message: string,
  fields: LogFields = {},
  now = new Date()
): void {
  writeLog(
    level,
    JSON.stringify({
      timestamp: now.toISOString(),
      level,
      service: SERVICE_NAME,
      environment: process.env.NODE_ENV ?? "development",
      event,
      message,
      ...removeUndefinedFields(fields)
    })
  );
}
