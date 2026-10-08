import type { Pool } from "pg";

import type { EmailSender } from "../email/email-sender";
import { LogisticsDeliveryRegisteredEmailHandler } from "./logistics-delivery-registered-email-handler";
import { LogisticsRecollectionExecutedNotificationHandler } from "./logistics-recollection-executed-notification-handler";
import { OutboxEventRouter } from "./outbox-event-router";
import { ProcessOutboxEvents } from "./process-outbox-events";

export type CreateLogisticsOutboxWorkerInput = {
  pool: Pool;
  emailSender: EmailSender;
  deliveryEmailRecipients: string[];
  managementTargetTeamContext: string;
};

export type LogisticsOutboxWorker = {
  handler: OutboxEventRouter;
  processor: ProcessOutboxEvents;
};

export function createLogisticsOutboxWorker(
  input: CreateLogisticsOutboxWorkerInput
): LogisticsOutboxWorker {
  const handler = new OutboxEventRouter([
    {
      eventType: "logistics.delivery_registered",
      aggregateType: "logistics_delivery",
      handler: new LogisticsDeliveryRegisteredEmailHandler(input.emailSender, {
        recipients: input.deliveryEmailRecipients
      })
    },
    {
      eventType: "logistics.recollection_executed",
      aggregateType: "logistics_recollection",
      handler: new LogisticsRecollectionExecutedNotificationHandler(input.pool, {
        targetTeamContext: input.managementTargetTeamContext
      })
    }
  ]);

  return {
    handler,
    processor: new ProcessOutboxEvents(input.pool, handler)
  };
}
