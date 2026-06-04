import { vi, describe, it, expect, beforeEach } from "vitest";
import { app } from "./app.js";
import { getDb } from "./storage/db.js";

vi.mock("./processing/queue.js", () => ({
  connectQueue: vi.fn().mockResolvedValue(undefined),
  closeQueue: vi.fn().mockResolvedValue(undefined),
  publishEvent: vi.fn(),
}));

vi.mock("./storage/db.js", () => ({
  connectDb: vi.fn().mockResolvedValue(undefined),
  closeDb: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn(),
}));

vi.mock("./observation/wsServer.js", () => ({
  registerWsServer: vi.fn().mockResolvedValue(undefined),
  broadcast: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe("GET /healthz", () => {
  it("returns 200 when MongoDB ping succeeds", async () => {
    vi.mocked(getDb).mockReturnValue({
      command: vi.fn().mockResolvedValue({ ok: 1 }),
    } as never);

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", mongo: "ok" });
  });

  it("returns 503 when MongoDB ping fails", async () => {
    vi.mocked(getDb).mockReturnValue({
      command: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as never);

    const res = await app.inject({ method: "GET", url: "/healthz" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: "degraded",
      mongo: "error: connection refused",
    });
  });
});
