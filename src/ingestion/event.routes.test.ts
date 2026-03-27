import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../server.js";

vi.mock("../processing/queue.js", () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

const validEvent = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  timestamp: "2026-01-01T00:00:00.000Z",
  source: "test",
  type: "app",
  payload: { action: "test.action" },
};

describe("POST /events", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 202 and the event id for a valid event", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: validEvent,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id: validEvent.id });
  });

  it("returns 422 for a missing required field", async () => {
    const { id: _omit, ...noId } = validEvent;

    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: noId,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toHaveProperty("errors");
  });

  it("returns 422 for an unknown event type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { ...validEvent, type: "unknown" },
    });

    expect(res.statusCode).toBe(422);
  });
});
