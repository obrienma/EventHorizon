---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-13, k3s, health-checks]
---
A k3s liveness probe exists to detect deadlocked or permanently degraded pods so they can be restarted. If `/healthz` always returns 200 even when MongoDB is dead, k3s never restarts the pod. The probe must touch the actual dependency via `{{c1::db.command({ ping: 1 })}}` to produce a meaningful signal.

Extra: EventHorizon · Phase 13 · Pattern: Dependency-Aware Health Check
See: docs/journal.md#phase-13-health-check-endpoint

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-13, k3s, health-checks]
---
Q: What's the difference between a k3s liveness probe and a readiness probe, and when would you split /healthz into two endpoints instead of one?

A: Liveness asks "Is this process alive and not stuck?" — failure triggers a pod restart. Readiness asks "Is this pod ready to serve traffic?" — failure removes the pod from the Service's endpoint list (stops routing) without restarting it. Readiness is the right tool when startup is slow or a pod needs to temporarily drain during a rolling deploy; liveness is for deadlock detection. A single /healthz serving both is standard for simple services — split them only if you need different restart vs. traffic-shedding behaviour.

Extra: EventHorizon · Phase 13 · Pattern: Dependency-Aware Health Check
See: docs/journal.md#phase-13-health-check-endpoint

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-13, anti-pattern, health-checks]
---
A health route that calls no external dependency is a {{c1::vanity probe}} — it proves the HTTP server is alive (which Docker/k3s can already detect from the TCP connection) but says nothing about whether the app can do useful work. The fix is to probe the minimum set of dependencies needed to handle a real request — for the server, that's {{c2::MongoDB}}.

Extra: EventHorizon · Phase 13 · Anti-Pattern Avoided: Healthcheck Without Dependency Verification
See: docs/journal.md#phase-13-health-check-endpoint

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-13, k3s, health-checks]
---
The worker process is a pure AMQP consumer with no HTTP server, so it can't use an `httpGet` liveness probe. Documented alternatives: an {{c1::exec probe}} where the worker writes a timestamp to `{{c2::/tmp/healthy}}` on each ack and k3s checks the file's mtime, or relying on `{{c3::restartPolicy: Always}}` with the dead-letter queue as the signal for stuck workers.

Extra: EventHorizon · Phase 13 · Decision: Worker Has No HTTP Health Endpoint
See: docs/journal.md#phase-13-health-check-endpoint

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-13, testing, mocking]
---
Q: The health route calls getDb().command({ ping: 1 }). What subtlety did this introduce into the Vitest mock setup compared to the existing event.routes.test.ts pattern?

A: The existing event route tests mock getDb but never call it, so its return value doesn't matter. The health route actually calls .command(...) on the result of getDb(), so the mock needs an explicit per-test return value: vi.mocked(getDb).mockReturnValue({ command: vi.fn()... }) — otherwise calling .command on the default mock return throws.

Extra: EventHorizon · Phase 13 · Challenge: getDb() Mock Needed an Explicit Return Value
See: docs/journal.md#phase-13-health-check-endpoint
