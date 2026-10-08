export type LogisticsOutboxWorkerConfig = {
  databaseUrl: string;
  deliveryEmailRecipients: string[];
  managementTargetTeamContext: string;
  batchSize: number;
};

export type LogisticsOutboxWorkerEnv = Readonly<Record<string, string | undefined>>;

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 100;

export function resolveLogisticsOutboxWorkerConfig(
  env: LogisticsOutboxWorkerEnv = process.env
): LogisticsOutboxWorkerConfig {
  const databaseUrl = normalizeRequired(env.DATABASE_URL, "DATABASE_URL");
  const deliveryEmailRecipients = parseRecipients(env.GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS);
  const managementTargetTeamContext = normalizeRequired(
    env.GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT,
    "GMAP_OUTBOX_MANAGEMENT_TARGET_TEAM_CONTEXT"
  );
  const batchSize = parseBatchSize(env.GMAP_OUTBOX_BATCH_SIZE);

  return {
    databaseUrl,
    deliveryEmailRecipients,
    managementTargetTeamContext,
    batchSize
  };
}

function parseRecipients(value: string | undefined): string[] {
  const recipients = (value ?? "")
    .split(",")
    .map((recipient) => recipient.trim())
    .filter((recipient) => recipient.length > 0);

  if (recipients.length === 0) {
    throw new Error("GMAP_OUTBOX_DELIVERY_EMAIL_RECIPIENTS deve informar ao menos um e-mail.");
  }

  return recipients;
}

function normalizeRequired(value: string | undefined, name: string): string {
  const normalized = (value ?? "").trim();

  if (normalized.length === 0) {
    throw new Error(`${name} deve ser informado.`);
  }

  return normalized;
}

function parseBatchSize(value: string | undefined): number {
  const normalized = (value ?? "").trim();

  if (normalized.length === 0) {
    return DEFAULT_BATCH_SIZE;
  }

  if (!/^\d+$/.test(normalized)) {
    throw new Error("GMAP_OUTBOX_BATCH_SIZE deve ser um inteiro positivo.");
  }

  const parsed = Number(normalized);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error("GMAP_OUTBOX_BATCH_SIZE deve estar entre 1 e 100.");
  }

  return parsed;
}
