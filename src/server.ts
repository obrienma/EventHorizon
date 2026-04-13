import Fastify from "fastify";
import { readFileSync } from "fs";
import { config } from "./config.js";
import { eventRoutes } from "./ingestion/event.routes.js";
import { connectQueue, closeQueue } from "./processing/queue.js";
import { connectDb, closeDb } from "./storage/db.js";
import { ensureIndexes } from "./storage/event.repository.js";
import { startChangeStream } from "./observation/changeStream.js";
import { registerWsServer, broadcast } from "./observation/wsServer.js";
import { startMetrics, recordInsert } from "./observation/metrics.js";

export const app = Fastify({ logger: true });

// ── Process-level error handlers ──────────────────────────────────────────────
// Registered BEFORE any top-level await so they are in place even if startup
// itself rejects (e.g. ECONNRESET during AMQP handshake or MongoDB timeout).
// Without early registration, a rejection from connectDb()/connectQueue() would
// fire before the handlers below exist and crash the process unhandled.

process.on("uncaughtException", (err) => {
  app.log.error(err, "uncaughtException");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  app.log.error(reason, "unhandledRejection");
  process.exit(1);
});

// ── Routes ────────────────────────────────────────────────────────────────────
void app.register(eventRoutes);
await registerWsServer(app);

const dashboardHtml = readFileSync(new URL("./dashboard/index.html", import.meta.url));
const faviconIco   = readFileSync(new URL("./dashboard/favicon.ico", import.meta.url));
app.get("/dashboard", (_req, reply) => reply.type("text/html").send(dashboardHtml));
app.get("/favicon.ico", (_req, reply) => reply.type("image/x-icon").send(faviconIco));

// ── Startup ───────────────────────────────────────────────────────────────────
await connectDb();
await ensureIndexes();
await connectQueue();

const closeChangeStream = startChangeStream((event) => {
  recordInsert(event);
  broadcast({ type: "event", data: event });
});

const stopMetrics = startMetrics(broadcast);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Order matters — see CLAUDE.md. Fastify drains in-flight requests first.
// Each plane (AMQP, MongoDB) will add its own teardown here as it is wired in.

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
    await closeQueue();              // step 4: close AMQP channel + connection
    app.log.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    app.log.error(err, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen({ port: config.PORT, host: config.HOST }, (err) => {
  if (err) {
    app.log.error(err, "failed to start server");
    process.exit(1);
  }
});
