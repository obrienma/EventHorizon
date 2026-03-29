import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../server.js";

vi.mock("../processing/queue.js", () => ({
  connectQueue: vi.fn().mockResolvedValue(undefined),
  closeQueue: vi.fn().mockResolvedValue(undefined),
  publishEvent: vi.fn(),
}));

vi.mock("../storage/db.js", () => ({
  connectDb: vi.fn().mockResolvedValue(undefined),
  closeDb: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn(),
}));

vi.mock("../storage/event.repository.js", () => ({
  ensureIndexes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../observation/changeStream.js", () => ({
  startChangeStream: vi.fn().mockReturnValue(() => Promise.resolve()),
}));

vi.mock("../observation/wsServer.js", () => ({
  registerWsServer: vi.fn().mockResolvedValue(undefined),
  broadcast: vi.fn(),
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
