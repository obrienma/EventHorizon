# Decision Log

Architectural and technology decisions, with rationale. Written as a reference for "why is it done this way?" questions.

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
