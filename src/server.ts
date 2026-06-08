import "./observation/tracing.js"; // must be first — registers OTel hooks before any instrumented module loads
import { trace, SpanKind } from "@opentelemetry/api";
import { app } from "./app.js";
import { config } from "./config.js";
import { connectQueue, closeQueue } from "./processing/queue.js";
import { connectDb, closeDb } from "./storage/db.js";
import { ensureIndexes } from "./storage/event.repository.js";
import { startChangeStream } from "./observation/changeStream.js";
import { broadcast, getConnectionCount } from "./observation/wsServer.js";
import { startMetrics, recordInsert } from "./observation/metrics.js";

// ── Startup ───────────────────────────────────────────────────────────────────
await connectDb();
await ensureIndexes();
await connectQueue();

const observeTracer = trace.getTracer("event-horizon-observe");

const closeChangeStream = await startChangeStream((event) => {
  const startMs = Date.now();
  const span = observeTracer.startSpan("event.observe", { kind: SpanKind.INTERNAL });

  recordInsert(event);
  broadcast({ type: "event", data: event });

  span.setAttributes({
    "event.id": event.raw.id,
    "event.type": event.raw.type,
    "subscribers.count": getConnectionCount(),
    "fanout.duration_ms": Date.now() - startMs,
    "changeStream.lag_ms": Date.now() - event._id.getTimestamp().getTime(),
  });
  span.end();
});

const stopMetrics = startMetrics(broadcast);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Order matters — see CLAUDE.md. Fastify drains in-flight requests first.
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, "shutdown signal received");

  try {
    await app.close();               // step 1: drain in-flight HTTP + WS
    stopMetrics();                   // step 2: stop stats broadcast interval
    await closeChangeStream();       // step 3: stop watching oplog
    await closeDb();                 // step 4: close MongoDB
    await closeQueue();              // step 5: close AMQP channel + connection
    app.log.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    app.log.error(err, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  app.log.error(err, "uncaughtException");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  app.log.error(reason, "unhandledRejection");
  process.exit(1);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen({ port: config.PORT, host: config.HOST }, (err) => {
  if (err) {
    app.log.error(err, "failed to start server");
    process.exit(1);
  }
});
