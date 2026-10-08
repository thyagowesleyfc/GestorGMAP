import { describe, expect, it } from "vitest";

import { OutboxEventRouter } from "../../../src/worker/outbox/outbox-event-router";
import type {
  OutboxEventHandler,
  OutboxEventRecord
} from "../../../src/worker/outbox/process-outbox-events";

describe("outbox event router", () => {
  it("dispatches events to the configured handler by event and aggregate type", async () => {
    const handled: string[] = [];
    const router = new OutboxEventRouter([
      {
        eventType: "logistics.delivery_registered",
        aggregateType: "logistics_delivery",
        handler: pushHandled(handled, "delivery")
      },
      {
        eventType: "logistics.recollection_executed",
        aggregateType: "logistics_recollection",
        handler: pushHandled(handled, "recollection")
      }
    ]);

    await router.handle(makeEvent("logistics.recollection_executed", "logistics_recollection"));
    await router.handle(makeEvent("logistics.delivery_registered", "logistics_delivery"));

    expect(handled).toEqual(["recollection:event-1", "delivery:event-1"]);
  });

  it("fails unsupported events so the outbox processor can retry or fail them", async () => {
    const router = new OutboxEventRouter([]);

    await expect(
      router.handle(makeEvent("logistics.unknown", "logistics_delivery"))
    ).rejects.toThrow(/sem handler configurado/);
  });

  it("fails aggregate type mismatches explicitly", async () => {
    const router = new OutboxEventRouter([
      {
        eventType: "logistics.delivery_registered",
        aggregateType: "logistics_delivery",
        handler: pushHandled([], "delivery")
      }
    ]);

    await expect(
      router.handle(makeEvent("logistics.delivery_registered", "logistics_recollection"))
    ).rejects.toThrow(/logistics\.delivery_registered\/logistics_recollection/);
  });

  it("rejects duplicate route configuration", () => {
    const route = {
      eventType: "logistics.delivery_registered",
      aggregateType: "logistics_delivery",
      handler: pushHandled([], "delivery")
    };

    expect(() => new OutboxEventRouter([route, route])).toThrow(/duplicada/);
  });
});

function pushHandled(target: string[], label: string): OutboxEventHandler {
  return {
    handle: async (event) => {
      target.push(`${label}:${event.id}`);
    }
  };
}

function makeEvent(eventType: string, aggregateType: string): OutboxEventRecord {
  return {
    id: "event-1",
    eventType,
    aggregateType,
    aggregateId: "aggregate-1",
    attempts: 0,
    payload: {}
  };
}
