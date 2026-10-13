import { Pool, type PoolConfig } from "pg";

import { SmtpEmailSender, type SmtpTransportFactory } from "../email/smtp-email-sender";
import {
  createLogisticsOutboxWorker,
  type LogisticsOutboxWorker
} from "./create-logistics-outbox-worker";
import {
  resolveLogisticsOutboxWorkerConfig,
  type LogisticsOutboxWorkerConfig,
  type LogisticsOutboxWorkerEnv
} from "./logistics-outbox-worker-config";

export type PoolFactory = (config: PoolConfig) => Pool;

export type CreateConfiguredLogisticsOutboxWorkerInput = {
  env?: LogisticsOutboxWorkerEnv;
  poolFactory?: PoolFactory;
  smtpTransportFactory?: SmtpTransportFactory;
};

export type ConfiguredLogisticsOutboxWorker = LogisticsOutboxWorker & {
  config: LogisticsOutboxWorkerConfig;
  pool: Pool;
  close(): Promise<void>;
};

export function createConfiguredLogisticsOutboxWorker(
  input: CreateConfiguredLogisticsOutboxWorkerInput = {}
): ConfiguredLogisticsOutboxWorker {
  const config = resolveLogisticsOutboxWorkerConfig(input.env);
  const poolFactory = input.poolFactory ?? createPool;
  const pool = poolFactory({ connectionString: config.databaseUrl });
  const emailSender = new SmtpEmailSender(config.smtpEmail, input.smtpTransportFactory);
  const worker = createLogisticsOutboxWorker({
    pool,
    emailSender,
    deliveryEmailRecipients: config.deliveryEmailRecipients,
    managementTargetTeamContext: config.managementTargetTeamContext
  });

  return {
    ...worker,
    config,
    pool,
    close: async () => {
      await pool.end();
    }
  };
}

function createPool(config: PoolConfig): Pool {
  return new Pool(config);
}
