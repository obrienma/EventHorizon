import Fastify from "fastify";
import { config } from "./config.js";
import { eventRoutes } from "./ingestion/event.routes.js";
import { connectQueue, closeQueue } from "./processing/queue.js";

export const app = Fastify({ logger: true });

// ── Routes ────────────────────────────────────────────────────────────────────
void app.register(eventRoutes);

// ── Startup ───────────────────────────────────────────────────────────────────
// TODO [step 5]: connectMongo()    — establish MongoDB client connection
// TODO [step 6]: startChangeStream() + startWsServer() — observation plane

await connectQueue();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Order matters — see CLAUDE.md. Fastify drains in-flight requests first.
// Each plane (AMQP, MongoDB) will add its own teardown here as it is wired in.

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, "shutdown signal received");

  try {
    await app.close();               // step 1: drain in-flight HTTP requests
    await closeQueue();              // step 2: close AMQP channel + connection
    // TODO [step 6]: closeChangeStream()
    // TODO [step 5]: closeMongoClient()
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
