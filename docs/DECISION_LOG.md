# Decision Log

_Last updated: 2026-06-14 · Verified against `src/`: 2026-06-14_

Architectural and technology decisions, with rationale. Written as a reference for "why is it done this way?" questions. Each entry links to its full [ADR](adr/) where one exists.

---

## 001 — TypeScript in strict mode

**Decision:** `"strict": true` in `tsconfig.json`, `NodeNext` module resolution.

**Why:** The entire point of the project is TypeScript learning. Strict mode forces you to handle `null`, `undefined`, and union cases explicitly. `NodeNext` resolution matches what Node.js actually does with ESM — no magic, no gaps between TS and runtime behaviour.

**Tradeoff:** More boilerplate initially. Worth it for the real-world practice.

---

## 002 — Fastify over Express

**Decision:** Fastify as the HTTP framework.

**Why:** Faster request throughput, built-in schema validation hooks that pair naturally with Zod, first-class TypeScript support, and `@fastify/websocket` for clean WS upgrades. For a project focused on throughput and plumbing, Fastify's architecture is more instructive than Express's middleware chain.

**Tradeoff:** Slightly smaller ecosystem than Express. Hasn't been an issue for this scope.

---

## 003 — RabbitMQ over BullMQ

**Decision:** RabbitMQ + `amqplib` instead of BullMQ (Redis-backed).

**Why:** RabbitMQ is the industry-standard message broker. AMQP concepts (exchanges, bindings, queues, ack/nack, prefetch, DLX) are directly transferable to professional environments. The Management UI (`localhost:15672`) gives free visual observability of the queue layer during development.

BullMQ was the original plan — it has a great TS API and removes ops complexity. But RabbitMQ better serves the learning goal: you implement retry logic and dead-lettering explicitly rather than getting it for free.

**Tradeoff:** More infrastructure to reason about. Dead-letter behaviour requires understanding AMQP exchange binding. This is a feature, not a bug.

**What you'd do differently at scale:** Add a separate RabbitMQ cluster with quorum queues, publisher confirms, and connection pooling.

---

## 004 — Topic exchange with `events.#` binding

**Decision:** Use a topic exchange bound with `events.#` rather than a direct exchange or a fanout.

**Why:** Routing key per event type (`events.pipeline`, `events.sensor`, `events.app`) makes it trivial to add new consumers for specific event types later. A consumer that only cares about sensor data binds `events.sensor` and gets only those messages. The `#` wildcard on the work queue catches all.

**Tradeoff:** Slightly more complex setup than a default queue. The topology is declared idempotently on startup so it's not painful.

---

## 005 — Dead-letter exchange for retry / failure handling

**Decision:** Configure `events.work` with `x-dead-letter-exchange` pointing to `events.dlx`, which fans out to `events.dead`.

**Why:** Dead-lettering is RabbitMQ's native mechanism for handling failed messages. Combined with `x-retry-count` in the message headers (tracked at the application level in the worker), this gives:
- Configurable retry attempts (currently 3)
- Automatic dead-lettering after max retries — no manual intervention needed
- A permanent record of failed messages in `events.dead` for inspection

**Alternative considered:** Republishing to a separate retry queue with per-attempt TTL (delayed retry). Adds complexity; not necessary for this scope.

---

## 006 — MongoDB as append-only event log

**Decision:** Never update `StoredEvent` documents. Every event is an immutable record. The `processed` sub-document is written once by the worker.

**Why:** Append-only / event sourcing mindset. The raw event is preserved exactly as received; the processed result is stored alongside it. If the classification logic changes, you can reprocess from raw. Easier to reason about data correctness.

**Idempotency:** `{ "raw.id": 1, unique: true }` index + silent duplicate-key handling in the repository = safe worker retries without duplicate documents.

**Tradeoff:** Slightly more storage per event (raw + processed together). Negligible at this scale.

---

## 007 — `@fastify/websocket` over socket.io

**Decision:** Raw WebSocket via `@fastify/websocket` instead of socket.io.

**Why:** socket.io adds a custom protocol layer, polling fallbacks, and event namespacing on top of WebSockets. It hides what's actually happening on the wire. For a project where learning the plumbing is the goal, starting with raw WS means you see exactly what messages look like, write your own message protocol, and handle reconnection yourself. Moving to socket.io later is trivial; going the other direction forces a full rewrite.

---

## 008 — MongoDB change stream over polling

**Decision:** React to new events via MongoDB change stream rather than polling `events` collection on a timer.

**Why:** The change stream approach demonstrates the Node.js streams API and async iterables directly. It's also architecturally correct — the database notifies downstream consumers of changes rather than consumers repeatedly asking "anything new?". This is the same pattern underpinning Kafka consumers, CDC pipelines, etc.

**Tradeoff:** Change streams require a replica set (or `mongod` started with `--replSet`). The Docker Compose setup handles this. Automated testing is skipped because of the replica set requirement — verified manually instead.

---

## 009 — Vitest over Jest

**Decision:** Vitest as the test runner.

**Why:** Native ESM support without babel transforms, faster watch mode, compatible with the TypeScript strict config, and `mongodb-memory-server` integrates cleanly. Jest requires additional ESM transformation config that fights against `NodeNext` module resolution.

---

## 010 — Single-file vanilla JS dashboard

**Decision:** `dashboard/index.html` — one file, inline JS, no build step, no framework.

**Why:** The dashboard is not the project. A React/Vue app would shift focus away from the backend plumbing. Vanilla WebSocket + DOM is ~150 lines and keeps the backend as the primary learning surface. The constraint also forces you to write a clean WebSocket message protocol (since you can't hide complexity behind a state management library).

---

## 011 — Change stream resume token recovery

**Decision:** When the MongoDB change stream cursor dies, reopen it with `{ resumeAfter: lastToken }` after exponential backoff (1s → 30s), rather than leaving a log-only error stub.

**Why:** The original log-only handler had a deceptive failure mode — the cursor would die (Mongo restart, replica-set election, network blip) while the server kept running and the dashboard looked healthy: stats still updated, the WS dot stayed green, but the live feed silently froze. A *blind* restart (reopen without a token) re-anchors at the current oplog head and permanently misses every event inserted during the outage, with no observable signal. The resume token is MongoDB's first-class mechanism for replay-from-checkpoint; every change event already carries one. Backoff resets on the first *delivered* event (not on reconnect), because a stream can reopen against a quiet collection and give false confidence.

**Tradeoff:** The token was held in memory only, so a full server restart still lost it — accepted at the time as "a restart is an operator action." Superseded by ADR 0013 once k3s made restarts involuntary.

**See also:** [ADR 0011](adr/0011-change-stream-resume-token-recovery.md)

---

## 012 — Zod over Valibot

**Decision:** Zod for all schema validation (HTTP payloads, environment variables, type inference).

**Why:** Valibot's primary advantage is a smaller bundle size — irrelevant here because this is a server-side Node.js application. Nothing is shipped to a browser, so download weight does not factor into the decision. Zod is the de-facto standard in the TypeScript/Node.js ecosystem with broader adoption, better ecosystem integrations, and far more community examples. The `z.infer<>` convention for deriving types from schemas is idiomatic and widely understood.

**Tradeoff:** Zod is not tree-shakeable in the same way as Valibot. At server scale this has no practical impact.

**See also:** [ADR 0012](adr/0012-zod-over-valibot.md)

---

## 013 — Durable resume token checkpoint

**Decision:** Persist the change stream resume token to a dedicated MongoDB collection (`changestream_checkpoints`, single document) via `src/observation/checkpoint.ts`, loaded on startup and written fire-and-forget on each delivered event.

**Why:** ADR 0011's in-memory token assumed a restart was intentional. The k3s work (Phase 14) broke that assumption: pod restarts are routine and involuntary (OOM kills, node evictions, rolling deploys, liveness failures), and each one silently re-anchored the stream at the oplog head, dropping events with no signal. MongoDB was chosen over Redis because the "circular dependency" concern is self-resolving — the token is only needed when Mongo is reachable, so no new infrastructure is required. Writes are fire-and-forget to keep a Mongo round-trip off the delivery hot path; the idempotent insert (unique `raw.id`, error 11000 swallowed) absorbs any replayed events. Oplog overrun (error 286, `ChangeStreamHistoryLost`) is detected explicitly — the stale checkpoint is cleared and the stream restarts from the current head, converting a permanent hang into a bounded gap.

**Tradeoff:** Adds one `updateOne` per delivered event; at high rates this should be debounced. Delivery guarantee is at-least-once, not exactly-once. Supersedes ADR 0011.

**See also:** [ADR 0013](adr/0013-durable-resume-token-checkpoint.md)

---

## 014 — Integration test strategy for the observation plane

**Decision:** Write integration tests for WebSocket broadcast first and change streams second (as explicit learning phases); defer full graceful-shutdown integration tests indefinitely and verify shutdown by unit-testing each step instead.

**Why:** WebSocket tests need no external infra — Fastify's first-class WS test support plus a `ws` client can assert message ordering and lifecycle. Change stream tests can run against `mongodb-memory-server` in replica-set mode, which enables oplog/resume-token round-trips, at the cost of ~1–2s startup. Signal-driven full-shutdown tests are timing-dependent and flaky in CI; the invariants that actually matter (ack-after-write, close ordering) are better asserted per-step than by orchestrating a real `SIGTERM`.

**Tradeoff:** Graceful-shutdown correctness stays a documentation and code-review concern rather than a test-suite guarantee.

**See also:** [ADR 0014](adr/0014-integration-test-strategy.md)

---

## 015 — OTel SDK bootstrap ordering in ESM entry points

**Decision:** Initialise the OpenTelemetry SDK via the **first-import pattern** — `import "./observation/tracing.js"` is the first static import in `src/server.ts` and `src/processing/worker.ts` — rather than a `--import` flag or `NODE_OPTIONS` preload.

**Why:** OTel must register instrumentation hooks before any instrumented module loads. Under ESM (`"type": "module"`), static imports are evaluated depth-first, left-to-right, so a module listed first is fully evaluated — including `tracing.ts`'s `sdk.start()` side effect — before siblings like `app.ts`, `queue.ts`, or `amqplib`. That ordering is a well-specified language guarantee, not a tsx implementation detail. The `--import`/`NODE_OPTIONS` approaches work but push the concern into npm scripts and lean on tsx's less-documented `.ts` preload path.

**Tradeoff:** Each entry point is responsible for the bootstrap line; a new entry point added without it silently misses instrumentation. The in-file comment ("must be first") mitigates this.

**See also:** [ADR 0015](adr/0015-otel-sdk-bootstrap-esm-entry-points.md)

---

## 016 — Wide span attributes over pre-aggregated Prometheus counters

**Decision:** Default new instrumentation to **span attributes** queried via TraceQL. Reserve Prometheus-style counters/gauges for signals that must drive threshold alerts regardless of trace sampling — currently `queueDepth` and the dead-letter rate. The test for a new signal: *"does this need to fire an alert independent of whether any particular trace was sampled?"* Yes → counter; no → span attribute.

**Why:** A counter commits to its label set at write time — once `events_by_type_total{type="sensor"}` exists you cannot retroactively slice by `source` if `source` was never a label, and over-labelling causes cardinality explosions. Span attributes carry no such commitment: stored raw per-span, they answer arbitrary after-the-fact combinations (`{ classification="critical" && event.source="sensor-7" }`) whether or not anyone anticipated that query. The split is drawn at alerting-vs-analysis: an alert must fire even if 99% of traces are dropped, so it needs an always-on counter; an analytical question benefits from the raw record only spans provide.

**Tradeoff:** Two systems to reason about, and the "alert vs analyze" test must be applied consistently as new signals are added. Existing `metrics.ts` counters stay as-is rather than migrating to spans.

**See also:** [ADR 0016](adr/0016-wide-spans-over-prometheus-counters.md)
