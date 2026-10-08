import type { OutboxEventHandler, OutboxEventRecord } from "./process-outbox-events";

export type OutboxEventRoute = {
  eventType: string;
  aggregateType: string;
  handler: OutboxEventHandler;
};

export class OutboxEventRouter implements OutboxEventHandler {
  private readonly routes: Map<string, OutboxEventHandler>;

  constructor(routes: OutboxEventRoute[]) {
    this.routes = new Map();

    for (const route of routes) {
      const key = routeKey(route.eventType, route.aggregateType);

      if (this.routes.has(key)) {
        throw new Error(
          `Rota de Outbox duplicada para evento ${route.eventType} e aggregate ${route.aggregateType}.`
        );
      }

      this.routes.set(key, route.handler);
    }
  }

  async handle(event: OutboxEventRecord): Promise<void> {
    const handler = this.routes.get(routeKey(event.eventType, event.aggregateType));

    if (handler === undefined) {
      throw new Error(
        `Evento de Outbox sem handler configurado: ${event.eventType}/${event.aggregateType}.`
      );
    }

    await handler.handle(event);
  }
}

function routeKey(eventType: string, aggregateType: string): string {
  return `${eventType}\u0000${aggregateType}`;
}
