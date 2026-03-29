import Fastify from "fastify";
import { config } from "./config.js";
import { eventRoutes } from "./ingestion/event.routes.js";
import { connectQueue, closeQueue } from "./processing/queue.js";
import { connectDb, closeDb } from "./storage/db.js";
import { ensureIndexes } from "./storage/event.repository.js";
import { startChangeStream } from "./observation/changeStream.js";
import { registerWsServer, broadcast } from "./observation/wsServer.js";

export const app = Fastify({ logger: true });

// ── Routes ────────────────────────────────────────────────────────────────────
void app.register(eventRoutes);
await registerWsServer(app);

// ── Startup ───────────────────────────────────────────────────────────────────
await connectDb();
await ensureIndexes();
await connectQueue();

const closeChangeStream = startChangeStream((event) =>
  broadcast({ type: "event", data: event }),
);

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
    await closeChangeStream();       // step 2: stop watching oplog
    await closeDb();                 // step 3: close MongoDB
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
