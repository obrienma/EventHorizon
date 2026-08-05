---
id: eventhorizon-2026-06-03T0930-health-check
repo: eventhorizon
title: "Health Check Endpoint"
date: 2026-06-03
phase: 13
tags: [k3s, health-checks, liveness, readiness, dependency-aware-probe, mongodb, testing]
files: [src/health.routes.ts, src/app.ts, src/health.routes.test.ts]
---

### Pattern: Dependency-Aware Health Check

A trivial 200 is useless to an orchestrator. k3s liveness probes exist to detect deadlocked or permanently degraded pods so they can be restarted; if `/healthz` always returns 200 even when the MongoDB connection is dead, k3s never restarts the pod and the silent failure persists indefinitely. The probe must touch the actual dependency (`db.command({ ping: 1 })`) to produce a meaningful signal. Liveness and readiness answer different questions in k3s: liveness asks "Is this process alive and not stuck?" — failure triggers a pod restart — while readiness asks "Is this pod ready to serve traffic?" — failure removes the pod from the Service's endpoint list, stopping routing without restarting it. Readiness is the right tool when startup is slow or a pod needs to temporarily drain during a rolling deploy; liveness is for deadlock detection. A single `/healthz` serving both is standard for simple services; splitting them is only necessary when different restart-versus-traffic-shedding behaviour is needed.

### Anti-Pattern Avoided: Healthcheck Without Dependency Verification

A health route that calls no external dependency is a vanity probe — it proves the HTTP server is alive, which Docker/k3s can already detect from the TCP connection, but says nothing about whether the app can do useful work. The fix probes the minimum set of dependencies needed to handle a real request. For the server, that means MongoDB, needed for the change stream and checkpoint reads.

### Decision: Worker Has No HTTP Health Endpoint

The worker process is a pure AMQP consumer with no HTTP server. Adding a minimal HTTP server just for health probing is possible but adds complexity. The pragmatic alternatives documented: an exec probe, where the worker writes a timestamp to `/tmp/healthy` on each message ack and k3s checks whether the file is recent; or no probe at all, relying on process-level restart policies (`restartPolicy: Always`) and the dead-letter queue as the signal for stuck workers. Documented as a TODO in the Deployment manifest.

### Challenge: `getDb()` Mock Needed an Explicit Return Value

The existing `event.routes.test.ts` established the exact mock pattern needed — `vi.mock` all module-level dependencies of `app.ts`, import the `app` singleton — and reusing that pattern for the health route test was straightforward, with one subtlety: the health route calls `getDb().command(...)`, so `getDb` needs a per-test return value (`vi.mocked(getDb).mockReturnValue({ command: vi.fn()... })`), unlike the event route tests, where `getDb` is mocked but never called.
