import { getDb } from "../storage/db.js";
import { EVENTS_COLLECTION } from "../storage/event.repository.js";
import { config } from "../config.js";
import type { StatsPayload, StoredEvent, EventType, WsMessage } from "../ingestion/event.schema.js";

// ── Pattern: Hybrid Pull/Push Metrics ────────────────────────────────────────
// Rate (processingRatePerSec) is tracked with an in-memory sliding window —
// updated on every change stream delivery (push), no I/O, zero latency.
// Totals (totalProcessed, failedCount) and queue depth are queried on the
// broadcast interval (pull) — accurate but add I/O per tick.
//
// Anti-Pattern Avoided: Unbounded Counter Arrays
// A naive approach appends timestamps forever and filters on each read.
// We prune the array on every insert so it stays bounded to at most
// (METRICS_RATE_WINDOW_MS / median inter-event gap) entries. At 1000 events/sec
// with a 10s window that's ~10,000 entries — still trivial, but worth knowing.
//
// Design Decision — RabbitMQ Management HTTP API for queue depth:
// The server process has no AMQP channel (only the worker does). Opening a
// dedicated AMQP channel just for queue inspection would consume a broker
// resource for every server instance. The Management API is a stateless HTTP
// call — no persistent connection, no resource held between ticks.
//
// Design Decision — changeStreamLagMs via ObjectId timestamp:
// MongoDB ObjectIds encode a 4-byte Unix timestamp (second precision).
// "Lag" = time from MongoDB commit (ObjectId timestamp) to change stream
// delivery (Date.now() in recordInsert). In a local dev replica set this will
// be <10ms; in a loaded prod cluster it can reach hundreds of ms and signal
// oplog consumer backpressure.

// ── Sliding window state ──────────────────────────────────────────────────────

const recentInsertTimestamps: number[] = [];
let lastChangeStreamLagMs = 0;

// ── recordInsert ──────────────────────────────────────────────────────────────
// Called by server.ts on every change stream delivery.
// Updates the rate window and measures delivery lag.

export function recordInsert(doc: StoredEvent): void {
  const now = Date.now();

  // Rate window: record this delivery time, prune expired entries.
  recentInsertTimestamps.push(now);
  const cutoff = now - config.METRICS_RATE_WINDOW_MS;
  while (recentInsertTimestamps.length > 0 && recentInsertTimestamps[0]! < cutoff) {
    recentInsertTimestamps.shift();
  }

  // Lag: ObjectId timestamp (second precision) vs delivery time.
  // TODO: if sub-second lag precision matters, use the clusterTime from the
  // change stream event (requires replica set with { showExpandedEvents: true }).
  const insertedAtMs = doc._id.getTimestamp().getTime();
  lastChangeStreamLagMs = now - insertedAtMs;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeRatePerSec(): number {
  const now = Date.now();
  const cutoff = now - config.METRICS_RATE_WINDOW_MS;
  const countInWindow = recentInsertTimestamps.filter((ts) => ts >= cutoff).length;
  return countInWindow / (config.METRICS_RATE_WINDOW_MS / 1000);
}

function queueDepthStatus(depth: number): "ok" | "warning" | "critical" {
  if (depth >= config.QUEUE_DEPTH_CRITICAL) return "critical";
  if (depth >= config.QUEUE_DEPTH_WARNING) return "warning";
  return "ok";
}

async function fetchQueueDepth(): Promise<number> {
  // Management API endpoint: GET /api/queues/{vhost}/{queue}
  // vhost "/" must be URL-encoded as "%2F".
  // TODO: make the vhost configurable if multi-vhost setups are needed.
  //
  // Note: credentials cannot be embedded in the URL — Node's native fetch
  // (and browsers) reject them for security reasons (leaks into logs/referrer).
  // Extract them and pass as a Basic Authorization header instead.
  try {
    const base = new URL(config.RABBITMQ_MANAGEMENT_URL);
    const auth = Buffer.from(`${base.username}:${base.password}`).toString("base64");
    const url = `${base.protocol}//${base.host}/api/queues/%2F/${encodeURIComponent(config.QUEUE_NAME)}`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      console.warn(`[metrics] management API responded ${res.status} — queue depth unavailable`);
      return 0;
    }
    const data = (await res.json()) as { messages?: number };
    return data.messages ?? 0;
  } catch (err) {
    console.warn("[metrics] could not reach RabbitMQ management API:", (err as Error).message);
    return 0;
  }
}

async function fetchEventTypeDistribution(): Promise<Record<EventType, number>> {
  // Design Decision — aggregation over countDocuments per type:
  // Three separate countDocuments calls would each do a collection scan (or
  // index scan) and round-trip to MongoDB. One aggregation pipeline does a
  // single pass and returns all three counts — 1 round-trip vs 3.
  //
  // TODO: this aggregation runs on every stats push. If the collection grows
  // large, consider caching the result on EVENT_DISTRIBUTION_POLL_MS and
  // serving the cached value between ticks.
  const rows = await getDb()
    .collection(EVENTS_COLLECTION)
    .aggregate<{ _id: EventType; count: number }>([
      { $match: { status: "processed" } },
      { $group: { _id: "$raw.type", count: { $sum: 1 } } },
    ])
    .toArray();

  const dist: Record<EventType, number> = { pipeline: 0, sensor: 0, app: 0 };
  for (const { _id, count } of rows) {
    if (_id in dist) dist[_id] = count;
  }
  return dist;
}

// ── startMetrics ──────────────────────────────────────────────────────────────
// Starts the stats broadcast interval. Returns a teardown function.
// broadcastFn is injected (not imported directly) so this module stays testable
// without a live WebSocket server.

export function startMetrics(broadcastFn: (msg: WsMessage) => void): () => void {
  const interval = setInterval(() => {
    void (async () => {
      try {
        const col = getDb().collection(EVENTS_COLLECTION);

        const [totalProcessed, failedCount, queueDepth, eventTypeDistribution] =
          await Promise.all([
            col.countDocuments({ status: "processed" }),
            col.countDocuments({ status: "failed" }),
            fetchQueueDepth(),
            fetchEventTypeDistribution(),
          ]);

        const stats: StatsPayload = {
          totalProcessed,
          failedCount,
          queueDepth,
          queueDepthStatus: queueDepthStatus(queueDepth),
          processingRatePerSec: computeRatePerSec(),
          changeStreamLagMs: lastChangeStreamLagMs,
          eventTypeDistribution,
        };

        broadcastFn({ type: "stats", data: stats });
      } catch (err) {
        // Don't let a bad tick kill the interval — metrics are best-effort.
        console.error("[metrics] error computing stats:", err);
      }
    })();
  }, config.STATS_PUSH_INTERVAL_MS);

  // unref() so this timer doesn't prevent clean shutdown after all other handles close.
  interval.unref();

  console.log(`[metrics] broadcasting stats every ${config.STATS_PUSH_INTERVAL_MS}ms`);

  return () => clearInterval(interval);
}
