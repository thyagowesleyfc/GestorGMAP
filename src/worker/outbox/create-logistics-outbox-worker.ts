import type { Pool } from "pg";

import type { EmailSender } from "../email/email-sender";
import { LogisticsDeliveryRegisteredEmailHandler } from "./logistics-delivery-registered-email-handler";
import { LogisticsDeliveryRegisteredNotificationHandler } from "./logistics-delivery-registered-notification-handler";
import { LogisticsRecollectionExecutedNotificationHandler } from "./logistics-recollection-executed-notification-handler";
import { OutboxEventRouter, type OutboxEventRoute } from "./outbox-event-router";
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
  const deliveryNotificationHandler = new LogisticsDeliveryRegisteredNotificationHandler(
    input.pool,
    {
      targetTeamContext: input.managementTargetTeamContext
    }
  );
  const deliveryEmailHandler = new LogisticsDeliveryRegisteredEmailHandler(input.emailSender, {
    recipients: input.deliveryEmailRecipients
  });
  const routes: OutboxEventRoute[] = [
    {
      eventType: "logistics.delivery_registered",
      aggregateType: "logistics_delivery",
      handler: {
        handle: async (event) => {
          await deliveryNotificationHandler.handle(event);
          await deliveryEmailHandler.handle(event);
        }
      }
    },
    {
      eventType: "logistics.recollection_executed",
      aggregateType: "logistics_recollection",
      handler: new LogisticsRecollectionExecutedNotificationHandler(input.pool, {
        targetTeamContext: input.managementTargetTeamContext
      })
    }
  ];
  const handler = new OutboxEventRouter(routes);

  return {
    handler,
    processor: new ProcessOutboxEvents(input.pool, handler, {
      supportedEvents: routes.map((route) => ({
        eventType: route.eventType,
        aggregateType: route.aggregateType
      }))
    })
  };
}
