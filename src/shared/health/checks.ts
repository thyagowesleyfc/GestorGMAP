export type HealthStatus = "ok" | "error";

export type HealthPayload = {
  service: "gestor-gmap";
  status: HealthStatus;
  timestamp: string;
};

export type ReadinessPayload = HealthPayload & {
  dependencies: {
    database: HealthStatus;
  };
};

export function createHealthPayload(now = new Date()): HealthPayload {
  return {
    service: "gestor-gmap",
    status: "ok",
    timestamp: now.toISOString()
  };
}

export async function createReadinessPayload(
  checkDatabase: () => Promise<unknown>,
  now = new Date()
): Promise<{ httpStatus: 200 | 503; payload: ReadinessPayload }> {
  try {
    await checkDatabase();

    return {
      httpStatus: 200,
      payload: {
        ...createHealthPayload(now),
        dependencies: {
          database: "ok"
        }
      }
    };
  } catch {
    return {
      httpStatus: 503,
      payload: {
        service: "gestor-gmap",
        status: "error",
        timestamp: now.toISOString(),
        dependencies: {
          database: "error"
        }
      }
    };
  }
}
