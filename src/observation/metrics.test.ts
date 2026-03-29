import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../storage/db.js");
vi.mock("../storage/event.repository.js", () => ({ EVENTS_COLLECTION: "events" }));

import { getDb } from "../storage/db.js";
import { startMetrics, recordInsert } from "./metrics.js";
import type { StoredEvent, WsMessage } from "../ingestion/event.schema.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build a minimal StoredEvent with a controllable ObjectId timestamp.
// ObjectId.createFromTime() accepts Unix seconds — second precision only.
function makeStoredEvent(insertedAtSec: number): StoredEvent {
  return {
    _id: ObjectId.createFromTime(insertedAtSec),
    raw: {
      id: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "test",
      type: "app",
      payload: { action: "login" },
    },
    status: "processed",
    processed: {
      receivedAt: new Date(),
      enrichedAt: new Date(),
      classification: "normal",
      tags: [],
    },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const mockCountDocuments = vi.fn();
const mockToArray = vi.fn();
const mockCollection = {
  countDocuments: mockCountDocuments,
  aggregate: vi.fn().mockReturnValue({ toArray: mockToArray }),
};

beforeEach(() => {
  // Pin fake time to a known epoch so ObjectId timestamp math is exact.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(20_000)); // t = 20 seconds from Unix epoch

  // Default MongoDB responses
  mockCountDocuments.mockResolvedValue(0);
  mockToArray.mockResolvedValue([]);
  vi.mocked(getDb).mockReturnValue({
    collection: vi.fn().mockReturnValue(mockCollection),
  } as unknown as ReturnType<typeof getDb>);

  // Default management API response
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ messages: 0 }),
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("startMetrics", () => {
  it("broadcasts a stats message on each tick", async () => {
    const broadcast = vi.fn();
    const stop = startMetrics(broadcast);

    await vi.advanceTimersByTimeAsync(5_000); // one STATS_PUSH_INTERVAL_MS tick

    expect(broadcast).toHaveBeenCalledOnce();
    const [msg] = broadcast.mock.calls[0] as [WsMessage];
    expect(msg.type).toBe("stats");

    stop();
  });

  it("payload contains all required StatsPayload fields", async () => {
    const broadcast = vi.fn();
    const stop = startMetrics(broadcast);

    await vi.advanceTimersByTimeAsync(5_000);

    const [msg] = broadcast.mock.calls[0] as [{ type: "stats"; data: Record<string, unknown> }];
    expect(msg.data).toHaveProperty("totalProcessed");
    expect(msg.data).toHaveProperty("failedCount");
    expect(msg.data).toHaveProperty("queueDepth");
    expect(msg.data).toHaveProperty("queueDepthStatus");
    expect(msg.data).toHaveProperty("processingRatePerSec");
    expect(msg.data).toHaveProperty("changeStreamLagMs");
    expect(msg.data).toHaveProperty("eventTypeDistribution");

    stop();
  });

  it("passes MongoDB counts into the payload", async () => {
    mockCountDocuments
      .mockResolvedValueOnce(42)  // totalProcessed
      .mockResolvedValueOnce(3);  // failedCount

    const broadcast = vi.fn();
    const stop = startMetrics(broadcast);

    await vi.advanceTimersByTimeAsync(5_000);

    const [msg] = broadcast.mock.calls[0] as [{ type: "stats"; data: { totalProcessed: number; failedCount: number } }];
    expect(msg.data.totalProcessed).toBe(42);
    expect(msg.data.failedCount).toBe(3);

    stop();
  });

  it('sets queueDepthStatus to "warning" when depth exceeds warning threshold', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ messages: 75 }), // > QUEUE_DEPTH_WARNING=50
      }),
    );

    const broadcast = vi.fn();
    const stop = startMetrics(broadcast);

    await vi.advanceTimersByTimeAsync(5_000);

    const [msg] = broadcast.mock.calls[0] as [{ type: "stats"; data: { queueDepth: number; queueDepthStatus: string } }];
    expect(msg.data.queueDepth).toBe(75);
    expect(msg.data.queueDepthStatus).toBe("warning");

    stop();
  });

  it('sets queueDepthStatus to "critical" when depth exceeds critical threshold', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ messages: 250 }), // > QUEUE_DEPTH_CRITICAL=200
      }),
    );

    const broadcast = vi.fn();
    const stop = startMetrics(broadcast);

    await vi.advanceTimersByTimeAsync(5_000);

    const [msg] = broadcast.mock.calls[0] as [{ type: "stats"; data: { queueDepthStatus: string } }];
    expect(msg.data.queueDepthStatus).toBe("critical");

    stop();
  });

  it("stop function prevents further broadcasts", async () => {
    const broadcast = vi.fn();
    const stop = startMetrics(broadcast);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(broadcast).toHaveBeenCalledOnce();

    stop();
    await vi.advanceTimersByTimeAsync(10_000); // two more ticks — should not fire

    expect(broadcast).toHaveBeenCalledOnce(); // still only once
  });

  it("processingRatePerSec reflects recordInsert calls within the window", async () => {
    // Fake time is pinned at t=20s. Record 10 inserts now.
    // METRICS_RATE_WINDOW_MS default = 10_000ms → rate = 10 inserts / 10s = 1.0/sec
    const doc = makeStoredEvent(Math.floor(Date.now() / 1000));
    for (let i = 0; i < 10; i++) recordInsert(doc);

    const broadcast = vi.fn();
    const stop = startMetrics(broadcast);

    await vi.advanceTimersByTimeAsync(5_000);

    const [msg] = broadcast.mock.calls[0] as [{ type: "stats"; data: { processingRatePerSec: number } }];
    expect(msg.data.processingRatePerSec).toBe(1.0);

    stop();
  });

  it("changeStreamLagMs reflects time between ObjectId timestamp and delivery", async () => {
    // Fake time = 20_000ms. Insert was committed 5 seconds ago → t=15s = 15 Unix seconds.
    // ObjectId second precision: lag = 20_000 - 15_000 = 5_000ms exactly.
    const doc = makeStoredEvent(15); // 15 Unix seconds
    recordInsert(doc);

    const broadcast = vi.fn();
    const stop = startMetrics(broadcast);

    await vi.advanceTimersByTimeAsync(5_000);

    const [msg] = broadcast.mock.calls[0] as [{ type: "stats"; data: { changeStreamLagMs: number } }];
    expect(msg.data.changeStreamLagMs).toBe(5_000);

    stop();
  });
});
