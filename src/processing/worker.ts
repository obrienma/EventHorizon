import "../observation/tracing.js"; // must be first — registers OTel hooks before any instrumented module loads
import amqp from "amqplib";
import { trace, context, propagation, metrics, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { ZodError } from "zod";
import { config } from "../config.js";
import { EventSchema, type AppEvent } from "../ingestion/event.schema.js";
import { enrich } from "../processors/enrich.js";
import { classify } from "../processors/classify.js";
import { connectDb, closeDb } from "../storage/db.js";
import { saveEvent, saveFailedEvent, ensureIndexes, EVENTS_COLLECTION } from "../storage/event.repository.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const tracer = trace.getTracer("event-horizon-worker", "1.0.0");

// Pattern: Aggregate Metric vs. Per-Operation Span (refines ADR 0016/0017)
// Per-event detail lives on the span (event.id, classification, write.collection).
// This Counter is the aggregate, rate-able signal Grafana needs: exported to
// Prometheus as events_processed_total{event_type="..."}, so per-type throughput
// is a sum()/rate() query rather than a trace search. Mirrors the in-app
// dashboard's eventTypeDistribution without coupling Grafana to the WebSocket.
const meter = metrics.getMeter("eventhorizon");
const processedCounter = meter.createCounter("events.processed", {
  description: "Events successfully processed and stored, labeled by event type",
});
// Companion failure counter on the dead-letter path. Exported as
// events_failed_total{event_type="..."} — an always-on, sampling-independent
// async-failure signal that the HTTP 5xx panel cannot see (the 500 surface ends
// at the 202; this fires after retries are exhausted). Parse failures have no
// parsed event, so the label falls back to a bounded "unknown" (keeps the label
// set closed per ADR 0017).
const failedCounter = meter.createCounter("events.failed", {
  description: "Events dead-lettered after exhausting retries, labeled by event type",
});

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
  // Connect to MongoDB before consuming — fail fast if unreachable.
  // A worker that can't persist events must not ack messages.
  await connectDb();
  await ensureIndexes();

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
      const msgHeaders = (msg.properties.headers ?? {}) as Record<string, unknown>;
      const retryCount =
        typeof msgHeaders["x-retry-count"] === "number" ? msgHeaders["x-retry-count"] : 0;

      // Extract OTel trace context from headers. Filter to string-valued keys only
      // since amqplib encodes non-string header values as Buffer objects.
      const carrier: Record<string, string> = {};
      for (const [k, v] of Object.entries(msgHeaders)) {
        if (typeof v === "string") carrier[k] = v;
      }
      const parentCtx = propagation.extract(context.active(), carrier);

      const span = tracer.startSpan(
        "event.process",
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            "messaging.system": "rabbitmq",
            "messaging.destination": config.QUEUE_NAME,
            "msg.routing_key": msg.fields.routingKey,
            "retry.count": retryCount,
          },
        },
        parentCtx,
      );

      // Hoisted so the catch block can call saveFailedEvent(event) when we have
      // a valid parsed event. If parsing itself throws, event stays undefined.
      let event: AppEvent | undefined;

      await context.with(trace.setSpan(parentCtx, span), async () => {
        try {
          // TODO: replace JSON.parse + EventSchema.parse with EventSchema.safeParse().
          // If parsing fails, should we retry (schema bug?) or dead-letter immediately
          // (malformed producer)? Think about which failure mode this represents.
          const raw: unknown = JSON.parse(msg.content.toString());
          event = EventSchema.parse(raw);

          span.setAttributes({
            "event.id": event.id,
            "event.type": event.type,
            "event.source": event.source,
            "event.timestamp": event.timestamp,
          });

          const enriched = enrich(event, receivedAt);
          const classified = classify(event);

          span.setAttributes({
            "classification": classified.classification,
            "classification.tags": classified.tags.join(","),
            "write.collection": EVENTS_COLLECTION,
          });

          await saveEvent(event, { ...enriched, ...classified });
          processedCounter.add(1, { "event.type": event.type });
          span.setStatus({ code: SpanStatusCode.OK });
          console.log(
            `[worker] processed ${event.type} event ${event.id}`,
            { classification: classified.classification, tags: classified.tags },
          );

          ch.ack(msg);
        } catch (err) {
          // Parse/schema failures are the known "silent-drop" path — surface them
          // as span events so they are queryable in Tempo.
          if (err instanceof SyntaxError || err instanceof ZodError) {
            span.addEvent("message.parse_failed", {
              "exception.type": err.constructor.name,
              "exception.message": err.message.slice(0, 512),
              "msg.routing_key": msg.fields.routingKey,
              "msg.size_bytes": msg.content.length,
              "retry.count": retryCount,
            });
          }

          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
          console.error(`[worker] error processing message (retry ${retryCount}/${MAX_RETRIES}):`, err);

          if (retryCount < MAX_RETRIES) {
            // Republish to the BACK of the queue with an incremented retry count.
            // We ack the original so it doesn't occupy a prefetch slot while waiting.
            //
            // ch.publish() is synchronous and returns false when the broker applies
            // flow control (channel write buffer full). If that happens, do NOT ack
            // the original — let RabbitMQ redeliver it. The occupied prefetch slot
            // is intentional: it applies backpressure to this consumer while the
            // broker is under load.
            const published = ch.publish(
              config.EXCHANGE_NAME,
              msg.fields.routingKey,
              msg.content,
              {
                persistent: true,
                contentType: msg.properties.contentType ?? "application/json",
                messageId: msg.properties.messageId as string | undefined,
                headers: { ...msgHeaders, "x-retry-count": retryCount + 1 },
              },
            );
            if (published) {
              ch.ack(msg);
            } else {
              console.warn("[worker] ch.publish() returned false (flow control) — holding ack, broker will redeliver");
            }
          } else {
            // Exhausted retries — nack without requeue → DLX routes to events.dead.
            // At-least-once delivery guarantee is preserved: we never silently drop.
            console.error(`[worker] dead-lettering message ${msg.properties.messageId ?? "(no id)"} after ${MAX_RETRIES} retries`);
            failedCounter.add(1, { "event.type": event?.type ?? "unknown" });
            // Best-effort: record the failed event in MongoDB for observability.
            // Wrapped in .catch() so a MongoDB failure never blocks the nack.
            if (event !== undefined) {
              await saveFailedEvent(event).catch((saveErr: unknown) => {
                console.error("[worker] could not record failed event in MongoDB:", saveErr);
              });
            }
            ch.nack(msg, false, false);
          }
        } finally {
          span.end();
        }
      });
    },
    { noAck: false }, // Manual acknowledgement — required for at-least-once delivery.
  );

  console.log(`[worker] consuming from "${config.QUEUE_NAME}" (tag: ${consumerTag})`);

  // ── Shutdown function ──────────────────────────────────────────────────────
  // Graceful shutdown order (from CLAUDE.md):
  //   cancel consumer → finish in-flight message → close channel → close connection
  // ch.cancel() stops new deliveries but lets the current handler finish.
  return async () => {
    await ch.cancel(consumerTag);  // stop new deliveries; in-flight handler finishes
    await closeDb();               // close MongoDB before AMQP (per graceful shutdown order)
    await ch.close();
    await model.close();
    console.log("[worker] shut down cleanly");
  };
}

// ── Entrypoint ─────────────────────────────────────────────────────────────────
// startWorker() returns a shutdown function. Wire it to process signals so
// `docker stop` / a process manager's SIGTERM triggers a clean drain.

const shutdown = await startWorker();

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
