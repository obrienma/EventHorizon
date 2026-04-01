import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { ConsumeMessage } from "amqplib";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
// mockCh must be in vi.hoisted() so it's available inside the amqplib factory.
// mockCh.consume captures the message handler when startWorker() calls it.

const { mockCh, getHandler } = vi.hoisted(() => {
  let _handler: ((msg: ConsumeMessage | null) => Promise<void>) | undefined;

  const mockCh = {
    prefetch: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockImplementation(
      async (_queue: string, handler: (msg: ConsumeMessage | null) => Promise<void>) => {
        _handler = handler;
        return { consumerTag: "test-tag" };
      },
    ),
    ack: vi.fn(),
    nack: vi.fn(),
    publish: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    assertExchange: vi.fn().mockResolvedValue(undefined),
    assertQueue: vi.fn().mockResolvedValue({ queue: "events.work", messageCount: 0, consumerCount: 0 }),
    bindQueue: vi.fn().mockResolvedValue(undefined),
  };

  return { mockCh, getHandler: () => _handler };
});

vi.mock("amqplib", () => ({
  default: {
    connect: vi.fn().mockResolvedValue({
      createChannel: vi.fn().mockResolvedValue(mockCh),
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    }),
  },
}));

vi.mock("../storage/db.js");
vi.mock("../storage/event.repository.js");

import { saveEvent, saveFailedEvent } from "../storage/event.repository.js";
import "./worker.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const validEvent = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  timestamp: "2026-01-01T00:00:00.000Z",
  source: "test",
  type: "app" as const,
  payload: { action: "login" },
};

function makeMsg(payload: unknown, retryCount = 0): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    fields: {
      routingKey: "events.app",
      exchange: "events",
      deliveryTag: 1,
      redelivered: false,
      consumerTag: "test-tag",
    },
    properties: {
      headers: { "x-retry-count": retryCount },
      contentType: "application/json",
    },
  } as unknown as ConsumeMessage;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let handle: (msg: ConsumeMessage | null) => Promise<void>;

beforeAll(() => {
  vi.mocked(saveEvent).mockResolvedValue(undefined);
  vi.mocked(saveFailedEvent).mockResolvedValue(undefined);
  const h = getHandler();
  if (!h) throw new Error("[test] handler not captured — ch.consume() was not called");
  handle = h;
});

beforeEach(() => {
  mockCh.ack.mockClear();
  mockCh.nack.mockClear();
  mockCh.publish.mockClear();
  vi.mocked(saveEvent).mockClear();
  vi.mocked(saveEvent).mockResolvedValue(undefined);
  vi.mocked(saveFailedEvent).mockClear();
  vi.mocked(saveFailedEvent).mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("worker message handler", () => {
  // ── Happy path ───────────────────────────────────────────────────────────

  it("calls saveEvent then acks on success", async () => {
    await handle(makeMsg(validEvent));

    expect(vi.mocked(saveEvent)).toHaveBeenCalledOnce();
    expect(mockCh.ack).toHaveBeenCalledOnce();
    expect(mockCh.nack).not.toHaveBeenCalled();
    expect(mockCh.publish).not.toHaveBeenCalled();
  });

  it("passes correct ProcessedMeta shape to saveEvent", async () => {
    await handle(makeMsg(validEvent));

    const [, processed] = vi.mocked(saveEvent).mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(processed).toHaveProperty("receivedAt");
    expect(processed).toHaveProperty("enrichedAt");
    expect(processed).toHaveProperty("classification");
    expect(processed).toHaveProperty("tags");
  });

  // ── Retry path ───────────────────────────────────────────────────────────

  it("republishes with incremented x-retry-count on transient error", async () => {
    vi.mocked(saveEvent).mockRejectedValueOnce(new Error("db error"));

    await handle(makeMsg(validEvent, 0));

    expect(mockCh.publish).toHaveBeenCalledOnce();
    const [, , , opts] = mockCh.publish.mock.calls[0] as [string, string, Buffer, { headers: Record<string, unknown> }];
    expect(opts.headers["x-retry-count"]).toBe(1);
    expect(mockCh.ack).toHaveBeenCalledOnce();
    expect(mockCh.nack).not.toHaveBeenCalled();
  });

  it("increments retry count from existing header value", async () => {
    vi.mocked(saveEvent).mockRejectedValueOnce(new Error("db error"));

    await handle(makeMsg(validEvent, 2));

    const [, , , opts] = mockCh.publish.mock.calls[0] as [string, string, Buffer, { headers: Record<string, unknown> }];
    expect(opts.headers["x-retry-count"]).toBe(3);
  });

  // ── Dead-letter path ─────────────────────────────────────────────────────

  it("calls saveFailedEvent and nacks after MAX_RETRIES exhausted", async () => {
    vi.mocked(saveEvent).mockRejectedValueOnce(new Error("db error"));

    await handle(makeMsg(validEvent, 3));

    expect(vi.mocked(saveFailedEvent)).toHaveBeenCalledOnce();
    expect(mockCh.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(mockCh.ack).not.toHaveBeenCalled();
    expect(mockCh.publish).not.toHaveBeenCalled();
  });

  it("nacks without saveFailedEvent when message fails schema validation", async () => {
    await handle(makeMsg({ not: "a-valid-event" }, 3));

    expect(vi.mocked(saveFailedEvent)).not.toHaveBeenCalled();
    expect(mockCh.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it("still nacks even if saveFailedEvent throws (best-effort write)", async () => {
    vi.mocked(saveEvent).mockRejectedValueOnce(new Error("db error"));
    vi.mocked(saveFailedEvent).mockRejectedValueOnce(new Error("mongo also down"));

    await handle(makeMsg(validEvent, 3));

    expect(mockCh.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  // ── Null message (broker cancellation) ───────────────────────────────────

  it("does nothing when msg is null", async () => {
    await handle(null);

    expect(mockCh.ack).not.toHaveBeenCalled();
    expect(mockCh.nack).not.toHaveBeenCalled();
    expect(vi.mocked(saveEvent)).not.toHaveBeenCalled();
  });
});
