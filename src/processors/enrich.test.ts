import { describe, it, expect } from "vitest";
import { enrich } from "./enrich.js";
import type { AppEvent } from "../ingestion/event.schema.js";

const baseEvent: AppEvent = {
  id: "00000000-0000-0000-0000-000000000001",
  timestamp: "2026-01-01T00:00:00.000Z",
  source: "test",
  type: "app",
  payload: { action: "login" },
};

describe("enrich", () => {
  it("returns receivedAt equal to the provided date", () => {
    const receivedAt = new Date("2026-01-01T12:00:00.000Z");
    const result = enrich(baseEvent, receivedAt);
    expect(result.receivedAt).toBe(receivedAt);
  });

  it("returns enrichedAt >= receivedAt", () => {
    const receivedAt = new Date();
    const result = enrich(baseEvent, receivedAt);
    expect(result.enrichedAt.getTime()).toBeGreaterThanOrEqual(receivedAt.getTime());
  });

  it("returns processingId", () => {
    expect(enrich(baseEvent).processingId).toBeTypeOf("string");
  });

  it("defaults receivedAt to now when not provided", () => {
    const before = new Date();
    const result = enrich(baseEvent);
    const after = new Date();
    expect(result.receivedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.receivedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
