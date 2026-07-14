# User Stories — EventHorizon

Stories are organised by domain. Each story is marked:
- ✅ **Implemented** — delivered in the current codebase
- 🔲 **Aspirational** — not yet built; a TODO exists in code or the linked ADR
- 🚫 **Deferred** — explicitly out of scope for this project; see the linked ADR

EventHorizon is observed through two **deliberately distinct** surfaces, not a
duplicated one. Where they overlap (rate, error count) they measure *different
planes*: Grafana's RED metrics are ingest-side (HTTP, pre-`202`); the in-app stats
are storage/worker-side (async failures and change-stream delivery that happen
*after* the `202`). Both surfaces show up below, against the stories they satisfy.

---

## 🔌 Event Ingestion

### ✅ 🔌 Submit an event without blocking on downstream processing
> As an integrator, I want to submit an event over plain HTTP and get an immediate acknowledgement, so that my producer is never blocked on downstream processing.

*Delivered by:* `POST /events` returns `202 Accepted` with the event id as soon as the message is published to RabbitMQ — enrichment, classification, and storage all happen asynchronously (`src/ingestion/event.routes.ts`)

---

### ✅ 🔌 Reject malformed events at the door
> As an integrator, I want malformed events rejected at the door with a clear reason, so that bad data never enters the pipeline and I can fix my payload quickly.

*Delivered by:* Zod discriminated union validation; failures return `422` with the list of Zod issues (`src/ingestion/event.schema.ts`, `event.routes.ts`)

---

### ✅ 🔌 Make retried POSTs safe
> As an integrator, I want retrying a failed POST to be safe, so that an at-least-once producer never creates duplicate stored events.

*Delivered by:* unique index on `raw.id`; duplicate inserts throw `11000`, caught and silently ignored — re-sending the same event id is a no-op (`src/storage/event.repository.ts`)

---

### ✅ 🔌 Send three event shapes through one endpoint
> As an integrator, I want to send three distinct event shapes (`pipeline`, `sensor`, `app`) through one endpoint, so that I don't need a separate API per telemetry type.

*Delivered by:* discriminated union routes each `type` to its own payload schema and RabbitMQ routing key `events.<type>` (`src/ingestion/event.schema.ts`; topic exchange + `events.#` binding in `src/processing/queue.ts`)

---

### 🔲 🔌 Get a meaningful status when the broker is unreachable
> As an integrator, I want a distinguishable error when RabbitMQ itself is unreachable, so that I can tell "the broker is down" apart from "my payload was rejected."

*TODO:* `publishEvent()` can throw if RabbitMQ is unavailable; today that bubbles to Fastify's default `500` handler, indistinguishable from any other unhandled error. See the `TODO` in `src/ingestion/event.routes.ts`.

---

## 📊 Live Dashboard & Operations

### ✅ 📊 Watch events arrive live, not polled
> As an operator, I want new events to appear in the dashboard within a second or two of arriving, so that I'm watching live state rather than a stale snapshot.

*Delivered by:* MongoDB change stream pushes each insert over a WebSocket as a `{ type: "event" }` message — no polling (`src/observation/changeStream.ts`, `wsServer.ts`)

---

### ✅ 📊 See pipeline health at a glance
> As an operator, I want a single glance to tell me whether the pipeline is keeping up, so that I can react before a backlog becomes an outage.

*Delivered by:* `{ type: "stats" }` broadcasts every `STATS_PUSH_INTERVAL_MS` (default 5s) with `queueDepth` colour-coded `ok` / `warning` (≥ 50) / `critical` (≥ 200), processing rate, change-stream lag, and per-type distribution (`src/observation/metrics.ts`, `wsServer.ts`)

---

### ✅ 📊 Triage failures via DLQ and failed count
> As an operator, I want to see when events are failing and inspect why, so that I can triage a bad producer or a processing bug.

*Delivered by:* messages that fail processing three times are dead-lettered to `events.dead`, inspectable in the RabbitMQ Management UI; the stats payload exposes `failedCount` (`src/processing/worker.ts`, `src/observation/metrics.ts`)

---

### ✅ 📊 See ingest-side RED metrics in Grafana
> As an operator, I want request rate, error rate, and latency percentiles in Grafana, so that I can see ingest-side health and trends over time — not just the instantaneous state the in-app dashboard shows.

*Delivered by:* OpenTelemetry auto-instrumentation exports HTTP and runtime metrics over OTLP; the "EventHorizon Service" Grafana dashboard renders RED metrics and Node.js runtime health (`src/observation/tracing.ts` → OTLP → Prometheus/Grafana, `rhizome-observability`)

---

### ✅ 📊 Survive a database hiccup without a restart
> As an operator, I want the live feed to survive a brief database hiccup without me restarting anything, so that transient infrastructure blips don't create blind spots.

*Delivered by:* the change stream recovers from cursor errors with a persisted resume token and exponential backoff, replaying events inserted during the outage (`src/observation/changeStream.ts`, `checkpoint.ts`)

---

### ✅ 📊 Query one pipeline run's full step history
> As an operator, I want to query the full step history of one pipeline run after the fact, so that I can diagnose a failure without scrolling back through the live feed or hand-writing a MongoDB query against the internal document shape.

*Delivered by:* GraphQL `pipelineRun(pipelineId)` / `pipelineRuns` and general `event` / `events` queries (filterable by type and status) over the same append-only store the live feed reads from (`src/graphql/schema.ts`, `resolvers.ts`; ADR 0019)

---

## 🛠️ Platform Operations

### ✅ 🛠️ Ship one image for both server and worker
> As a platform engineer, I want one container image that can run as either the server or the worker, so that I have a single artifact to build, scan, and promote.

*Delivered by:* multi-stage `Dockerfile` producing a lean non-root image; the server is the default `CMD`, the worker overrides it (`node dist/processing/worker.js`) (`Dockerfile`; `k3s/server.yaml`, `k3s/worker.yaml`)

---

### ✅ 🛠️ Give k3s a real liveness/readiness signal
> As a platform engineer, I want Kubernetes to know when a pod is actually healthy, so that liveness/readiness probes restart or hold traffic correctly.

*Delivered by:* `GET /healthz` pings MongoDB and returns `200 {status:"ok"}` or `503 {status:"degraded"}`, wired to both k3s probes (`src/health.routes.ts`; `k3s/server.yaml`)

---

### ✅ 🛠️ Scale throughput by adding workers
> As a platform engineer, I want to scale throughput by adding workers, so that I can absorb load spikes without redesigning the pipeline.

*Delivered by:* workers are competing consumers on `events.work` with `prefetch` backpressure; the k3s worker Deployment runs `replicas: 2` and is safe to scale because inserts are idempotent (`src/processing/worker.ts`, `queue.ts`; `k3s/worker.yaml`)

---

### ✅ 🛠️ Survive pod restarts without dropping events
> As a platform engineer, I want a pod restart to never silently drop events, so that routine k3s churn (evictions, rolling deploys, OOM kills) doesn't create data gaps.

*Delivered by:* the change-stream resume token is persisted to MongoDB and reloaded on startup, so a restarted pod replays missed inserts instead of re-anchoring at the oplog head (`src/observation/checkpoint.ts`; ADR 0013)

---

### ✅ 🛠️ Trace one event across all four planes
> As a platform engineer, I want to follow a single event across all four planes when debugging, so that I can see where latency or failure actually occurs.

*Delivered by:* OpenTelemetry wide spans on every stage, with W3C trace context propagated across the RabbitMQ boundary — one connected trace from HTTP ingest to WebSocket fanout (`src/observation/tracing.ts`; context propagation in `queue.ts` + `worker.ts`; ADR 0015, 0016)

---

### ✅ 🛠️ Export signals to the shared observability stack
> As a platform engineer, I want EventHorizon's signals in the shared observability stack, so that it's monitored alongside my other services rather than through a bespoke per-app dashboard.

*Delivered by:* traces, metrics, and logs exported over OTLP to a collector endpoint configured by `OTEL_*` env vars; the service identifies itself via `OTEL_SERVICE_NAME` (`src/observation/tracing.ts`; `src/config.ts`)

---

### ✅ 🛠️ Inject controlled faults on demand
> As a platform engineer, I want to inject controlled faults on demand, so that I can verify the observability surfaces actually reflect real 4xx/5xx and failure traffic before relying on them.

*Delivered by:* `CHAOS_ERROR_RATE` makes the server throw after validation to produce genuine 500s; the seed producer's `--error-rate` emits malformed ids to trigger genuine 422s. Both default to 0 and are off unless explicitly set (`src/config.ts`, `event.routes.ts`; `src/seed/producer.ts`)

---

### ✅ 🛠️ Bound memory for a stalled WebSocket subscriber
> As a platform engineer, I want the server to shed output to a stalled WebSocket subscriber rather than buffer for it indefinitely, so that one slow consumer (an idle dashboard tab, or an external subscriber like Synapse-L4) can't grow the process's memory without bound.

*Delivered by:* `broadcast()` checks each client's `bufferedAmount`, skipping above a threshold and terminating the connection above a second, higher threshold — mirroring the bounded backpressure `WORKER_PREFETCH` already applies at the RabbitMQ layer (`src/observation/wsServer.ts` — `WS_BUFFERED_AMOUNT_SKIP` / `WS_BUFFERED_AMOUNT_TERMINATE`; ADR 0018)

---

### 🚫 🛠️ Federate queries across EventHorizon and Synapse-L4
> As a platform engineer, I want one GraphQL endpoint that can resolve fields spanning both EventHorizon's stored events and Synapse-L4's downstream Axioms, so that I don't need to query two services separately to trace a telemetry event's full lifecycle.

*Deferred:* See ADR 0019 — the GraphQL API is deliberately scoped to data EventHorizon already owns (the `events` collection, in-memory stats); no cross-service call to Synapse-L4 is included. Revisit if a genuine cross-service query need emerges.

---

## 🔍 Codebase Maintainability

### ✅ 🔍 Implement delivery guarantees explicitly, not via a library default
> As a maintainer, I want at-least-once delivery and competing consumers implemented explicitly against a real broker, so that the delivery guarantees are visible and auditable rather than buried in a job library's defaults.

*Delivered by:* RabbitMQ topology, prefetch, and `ack`-after-write are spelled out in code, so their trade-offs can be reviewed and tuned directly (`src/processing/queue.ts`, `worker.ts`; ADR 0003)

---

### ✅ 🔍 Implement retry and dead-lettering by hand
> As a maintainer, I want retry and dead-lettering implemented by hand, so that the failure-handling behavior is auditable and modifiable at the AMQP level rather than opaque.

*Delivered by:* application-level `x-retry-count` (max 3) drives republish-or-dead-letter via a DLX (`src/processing/worker.ts`, `queue.ts`; ADR 0005)

---

### ✅ 🔍 Flow one schema-derived type through every plane
> As a maintainer, I want one shared, schema-derived type to flow through every plane, so that a contract change propagates coherently across the whole multi-stage system.

*Delivered by:* `AppEvent` is `z.infer<>`-derived from the Zod schema and imported by every plane; no plane defines its own event shape (`src/ingestion/event.schema.ts`; ADR 0012)

---

### ✅ 🔍 Make the shutdown sequence explicit and ordered
> As a maintainer, I want an explicit, ordered graceful-shutdown sequence, so that the guarantee against message loss is verifiable rather than incidental.

*Delivered by:* shutdown drains HTTP/WS, cancels the consumer, closes the change stream, then MongoDB, then the AMQP channel and connection — in that exact order (`src/app.ts`, `server.ts`, `src/processing/worker.ts`; [ARCHITECTURE.md](ARCHITECTURE.md#graceful-shutdown-sequence))

---

### ✅ 🔍 Make pipeline-internal health alertable, not just live
> As a maintainer, I want queue depth, change-stream lag, and per-type throughput available as metrics, so that pipeline-internal health is alertable and historically queryable — not only visible live in the in-app dashboard.

*Delivered by:* queue depth is scraped from RabbitMQ's own exporter; change-stream lag and per-type throughput are emitted as custom OTel metrics from the pipeline itself (`src/observation/metrics.ts`, `src/processing/worker.ts`; ADR 0017)

---

### ✅ 🔍 Keep GraphQL resolvers N+1-safe by construction
> As a maintainer, I want a query resolver that can't silently regress into an N+1, so that "get the steps for 20 pipeline runs" stays one database round trip as the schema grows, not twenty.

*Delivered by:* a per-request `DataLoader` batches every `pipelineStepsLoader.load(pipelineId)` call made while resolving one GraphQL query into a single `find(... $in ...)`; the Apollo context factory creates a fresh loader per request so caching never leaks across unrelated requests (`src/graphql/loaders.ts`, `plugin.ts`; ADR 0019)

---

See also: [ARCHITECTURE.md](ARCHITECTURE.md) · [SERVICES.md](SERVICES.md) ·
[API.md](API.md) · [DECISION_LOG.md](DECISION_LOG.md).
