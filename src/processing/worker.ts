import amqp from "amqplib";
import { config } from "../config.js";
import { EventSchema } from "../ingestion/event.schema.js";
import { enrich } from "../processors/enrich.js";
import { classify } from "../processors/classify.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

// ── startWorker ───────────────────────────────────────────────────────────────
// Pattern: Competing Consumers
// Multiple worker processes can all consume from events.work simultaneously.
// RabbitMQ distributes messages across them; no coordination required between
// workers — the broker is the coordinator.
//
// Design Decision — worker owns its own AMQP connection:
// queue.ts (publisher) and worker.ts (consumer) are separate processes with
// separate lifecycles. Sharing a connection would couple their shutdown paths
// and create a single point of failure. Each gets its own ChannelModel.
//
// Returns a shutdown function — the caller (graceful shutdown) must invoke it
// after in-flight messages are drained to prevent message loss.

export async function startWorker(): Promise<() => Promise<void>> {
  const model = await amqp.connect(config.RABBITMQ_URL);

  model.on("error", (err: Error) => {
    console.error("[worker] connection error:", err.message);
  });

  const ch = await model.createChannel();

  ch.on("error", (err: Error) => {
    console.error("[worker] channel error:", err.message);
  });

  // Anti-Pattern Avoided: Unbounded Consumption
  // Without prefetch, the broker pushes ALL queued messages to the first
  // consumer that connects. A burst of 10,000 messages would be loaded into
  // memory simultaneously, causing head-of-line blocking and potential OOM.
  // prefetch(N) caps unacknowledged messages per consumer to N.
  await ch.prefetch(config.WORKER_PREFETCH);

  const { consumerTag } = await ch.consume(
    config.QUEUE_NAME,
    async (msg) => {
      // msg === null means the broker cancelled the consumer (e.g., queue deleted).
      // Nothing to ack — just return.
      if (msg === null) {
        console.warn("[worker] consumer cancelled by broker");
        return;
      }

      const receivedAt = new Date();

      // Read application-level retry count from message headers.
      // Design Decision — header-based retry vs. DLX TTL re-queue:
      // RabbitMQ's built-in requeue (nack + requeue=true) puts the message at
      // the FRONT of the queue — head-of-line blocking. A poison message would
      // starve all other messages behind it. Instead, we republish to the BACK
      // of the queue with an incremented counter and let natural expiry (x-message-ttl)
      // act as a final safety net.
      const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
      const retryCount =
        typeof headers["x-retry-count"] === "number" ? headers["x-retry-count"] : 0;

      try {
        // TODO: replace JSON.parse + EventSchema.parse with EventSchema.safeParse().
        // If parsing fails, should we retry (schema bug?) or dead-letter immediately
        // (malformed producer)? Think about which failure mode this represents.
        const raw: unknown = JSON.parse(msg.content.toString());
        const event = EventSchema.parse(raw);

        const enriched = enrich(event, receivedAt);
        const classified = classify(event);

        // TODO (Step 3 — Storage Plane): call saveEvent() here.
        // const stored = await saveEvent({ raw: event, status: "processed", processed: { ...enriched, ...classified } });
        // For now, log so we can verify the pipeline is flowing end-to-end.
        console.log(
          `[worker] processed ${event.type} event ${event.id}`,
          { classification: classified.classification, tags: classified.tags },
        );

        ch.ack(msg);
      } catch (err) {
        console.error(`[worker] error processing message (retry ${retryCount}/${MAX_RETRIES}):`, err);

        if (retryCount < MAX_RETRIES) {
          // Republish to the BACK of the queue with an incremented retry count.
          // We ack the original so it doesn't occupy a prefetch slot while waiting.
          ch.publish(
            config.EXCHANGE_NAME,
            msg.fields.routingKey,
            msg.content,
            {
              persistent: true,
              contentType: msg.properties.contentType ?? "application/json",
              headers: { ...headers, "x-retry-count": retryCount + 1 },
            },
          );
          ch.ack(msg);
        } else {
          // Exhausted retries — nack without requeue → DLX routes to events.dead.
          // At-least-once delivery guarantee is preserved: we never silently drop.
          console.error(`[worker] dead-lettering message ${msg.properties.messageId ?? "(no id)"} after ${MAX_RETRIES} retries`);
          ch.nack(msg, false, false);
        }
      }
    },
    { noAck: false }, // Manual acknowledgement — required for at-least-once delivery.
  );

  console.log(`[worker] consuming from "${config.QUEUE_NAME}" (tag: ${consumerTag})`);

  // ── Shutdown function ────────────────────────────────────────────────────────
  // Graceful shutdown order (from CLAUDE.md):
  //   cancel consumer → finish in-flight message → close channel → close connection
  // ch.cancel() stops new deliveries but lets the current handler finish.
  return async () => {
    await ch.cancel(consumerTag);
    await ch.close();
    await model.close();
    console.log("[worker] shut down cleanly");
  };
}
