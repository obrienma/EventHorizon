import type { FastifyInstance } from "fastify";
import { getDb } from "./storage/db.js";

// ── Pattern: Dependency-Aware Health Check ────────────────────────────────────
// A health endpoint that always returns 200 is useless — the orchestrator
// would never restart a deadlocked pod that still accepts TCP connections.
// This probe pings MongoDB so k3s gets a meaningful liveness signal.
//
// Liveness vs readiness (k3s probe types):
//   Liveness  — "Is the process alive and not deadlocked?" Failure restarts pod.
//   Readiness — "Can this pod handle traffic?" Failure removes it from the
//               service load balancer without restarting it.
// A single /healthz endpoint serving both is standard for simple services.
// Split them only if you need different restart vs. traffic-shedding behaviour.
//
// Worker note: the worker process has no HTTP server so it cannot expose a
// /healthz endpoint. The worker Deployment in k3s should use an exec probe
// (worker writes a heartbeat file; probe checks its mtime) or omit the probe
// and rely on process-level restart policies.

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async (_req, reply) => {
    try {
      await getDb().command({ ping: 1 });
      return reply.send({ status: "ok", mongo: "ok" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      return reply.status(503).send({ status: "degraded", mongo: `error: ${message}` });
    }
  });
}
