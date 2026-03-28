import amqp from "amqplib";
import { config } from "../config.js";
import type { AppEvent } from "../ingestion/event.schema.js";

// ── State ─────────────────────────────────────────────────────────────────────
// amqp.connect() returns a ChannelModel (not Connection).
// ChannelModel has createChannel(), close(), and exposes .connection underneath.

let channelModel: amqp.ChannelModel | null = null;
let channel: amqp.Channel | null = null;

// ── Topology constants ────────────────────────────────────────────────────────

const DLX_EXCHANGE = "events.dlx";
const DLX_QUEUE = config.DEAD_LETTER_QUEUE; // events.dead

// ── connectQueue ──────────────────────────────────────────────────────────────
// Design Decision: no top-level await / no side effects on import.
// This function is called explicitly by server.ts at startup. Tests that import
// publishEvent can vi.mock() this module without triggering a real connection.

export async function connectQueue(): Promise<void> {
  const model = await amqp.connect(config.RABBITMQ_URL);

  // Unhandled 'error' events on an EventEmitter crash the process.
  // amqplib ChannelModel and Channel are EventEmitters — register handlers on both.
  model.on("error", (err: Error) => {
    console.error("[queue] connection error:", err.message);
  });

  const ch = await model.createChannel();

  ch.on("error", (err: Error) => {
    console.error("[queue] channel error:", err.message);
  });

  // ── Topology declaration (idempotent) ───────────────────────────────────────
  // assertExchange / assertQueue are no-ops if already declared with same args.
  // Changing args on a live queue requires deleting it first (406 PRECONDITION_FAILED).

  // 1. Dead-letter fanout — events.dlx → events.dead
  await ch.assertExchange(DLX_EXCHANGE, "fanout", { durable: true });
  await ch.assertQueue(DLX_QUEUE, { durable: true });
  await ch.bindQueue(DLX_QUEUE, DLX_EXCHANGE, "");

  // 2. Work exchange — topic, routes events.pipeline / events.sensor / events.app
  await ch.assertExchange(config.EXCHANGE_NAME, "topic", { durable: true });

  // 3. Work queue — durable, DLX-backed, 30 s TTL safety net
  await ch.assertQueue(config.QUEUE_NAME, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": DLX_EXCHANGE,
      "x-message-ttl": 30_000,
    },
  });

  // 4. Bind work queue to exchange — catch all events.* routing keys
  await ch.bindQueue(config.QUEUE_NAME, config.EXCHANGE_NAME, "events.#");

  channelModel = model;
  channel = ch;

  console.log("[queue] topology ready");
}

// ── publishEvent ──────────────────────────────────────────────────────────────
// Routing key: events.<type>  e.g. events.sensor
// Messages are published persistent (deliveryMode 2) so they survive broker restart.
// All three of exchange durable + queue durable + persistent message are required.

export function publishEvent(event: AppEvent): void {
  if (channel === null) {
    throw new Error("[queue] publishEvent called before connectQueue()");
  }

  const routingKey = `events.${event.type}`;
  const body = Buffer.from(JSON.stringify(event));

  // channel.publish() returns false when the write buffer is full (backpressure).
  // TODO: implement drain handling for high-throughput scenarios.
  const ok = channel.publish(config.EXCHANGE_NAME, routingKey, body, {
    persistent: true,
    contentType: "application/json",
  });

  if (!ok) {
    console.warn("[queue] write buffer full — backpressure on exchange", config.EXCHANGE_NAME);
  }
}

// ── closeQueue ────────────────────────────────────────────────────────────────
// Called during graceful shutdown (server.ts onClose hook).
// Order: close channel first, then connection — prevents in-flight acks being lost.

export async function closeQueue(): Promise<void> {
  await channel?.close();
  await channelModel?.close();
  channel = null;
  channelModel = null;
}
