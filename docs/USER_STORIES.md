# User Stories

_Last updated: 2026-06-15 · Verified against `src/`: 2026-06-15_

EventHorizon is a learning vehicle — the telemetry domain is scaffolding for the
distributed-systems plumbing. These stories frame that plumbing around the people who
actually interact with the system, so each capability has a clear "who is this for and
why." Every story ends with a **Satisfied by** line pointing at the plane, file, or
feature that delivers it, so the document doubles as a traceability map from intent to code.

Personas:

1. **Event/API integrator** — a service or script that emits telemetry into the pipeline.
2. **Dashboard viewer / on-call operator** — a human watching the live system.
3. **Platform engineer** — whoever builds, deploys, and scales EventHorizon.
4. **Maintainer** — whoever evolves, audits, and operates the codebase over time.

---

## Observability surfaces

EventHorizon is observed through two **deliberately distinct** surfaces — not a
duplicated one. Where they overlap (rate, error count) they measure *different
planes*: Grafana's RED metrics are ingest-side (HTTP, pre-`202`), while the in-app
stats are storage/worker-side (async failures and change-stream delivery that
happen after the `202`).

- **In-app dashboard** (Observation Plane → WebSocket): a live operational
  wall-board — the real-time per-event feed plus pipeline-internal stats
  (`queueDepth`, `changeStreamLagMs`, `eventTypeDistribution`). Zero extra infra,
  but ephemeral — no history, no alerting.
- **Grafana** (`rhizome-observability`): historical, cross-service, alertable —
  RED metrics, Node.js runtime health, distributed traces, and (via custom OTel
  metrics) the same pipeline-internal signals for trend analysis and alerts.

---

## 1. Event/API integrator

> *A producer that POSTs telemetry events into the pipeline.*

- **As an integrator, I want to submit an event over plain HTTP and get an immediate
  acknowledgement, so that my producer is never blocked on downstream processing.**
  Posting to `POST /events` returns `202 Accepted` with the event id as soon as the
  message is published to RabbitMQ — enrichment, classification, and storage all happen
  asynchronously.
  **Satisfied by:** Ingestion Plane — `src/ingestion/event.routes.ts` (202-on-publish).

- **As an integrator, I want malformed events rejected at the door with a clear reason,
  so that bad data never enters the pipeline and I can fix my payload quickly.**
  Bodies are validated against a Zod discriminated union; failures return `422` with the
  list of Zod issues.
  **Satisfied by:** Ingestion Plane — `src/ingestion/event.schema.ts`, `event.routes.ts`.

- **As an integrator, I want retrying a failed POST to be safe, so that an at-least-once
  producer never creates duplicate stored events.**
  Storage is keyed on a unique index over `raw.id`; duplicate inserts are silently ignored
  (duplicate-key `11000` swallowed), so re-sending the same event id is a no-op.
  **Satisfied by:** Storage Plane — `src/storage/event.repository.ts` (idempotent insert).

- **As an integrator, I want to send three distinct event shapes (`pipeline`, `sensor`,
  `app`) through one endpoint, so that I don't need a separate API per telemetry type.**
  A discriminated union routes each `type` to its own payload schema and RabbitMQ routing
  key (`events.<type>`).
  **Satisfied by:** Ingestion Plane — `src/ingestion/event.schema.ts`; Processing Plane —
  `src/processing/queue.ts` (topic exchange, `events.#` binding).

---

## 2. Dashboard viewer / on-call operator

> *A human watching telemetry flow and the health of the pipeline in real time.*

- **As an operator, I want new events to appear in the dashboard within a second or two of
  arriving, so that I'm watching live state rather than a stale snapshot.**
  A MongoDB change stream pushes each insert over a WebSocket as a `{ type: "event" }`
  message — no polling.
  **Satisfied by:** Observation Plane — `src/observation/changeStream.ts`,
  `src/observation/wsServer.ts`.

- **As an operator, I want a single glance to tell me whether the pipeline is keeping up,
  so that I can react before a backlog becomes an outage.**
  A `{ type: "stats" }` message broadcasts every `STATS_PUSH_INTERVAL_MS` (default 5s) with
  `queueDepth` colour-coded `ok` / `warning` (≥ 50) / `critical` (≥ 200), processing rate,
  change-stream lag, and per-type distribution.
  **Satisfied by:** Observation Plane — `src/observation/metrics.ts`, `wsServer.ts`.

- **As an operator, I want to see when events are failing and inspect why, so that I can
  triage a bad producer or a processing bug.**
  Messages that fail processing three times are dead-lettered to `events.dead`, inspectable
  in the RabbitMQ Management UI; the stats payload exposes `failedCount`.
  **Satisfied by:** Processing Plane — `src/processing/worker.ts` (retry → DLQ);
  Observation Plane — `src/observation/metrics.ts`.

- **As an operator, I want request rate, error rate, and latency percentiles in Grafana, so
  that I can see ingest-side health and trends over time — not just the instantaneous state
  the in-app dashboard shows.**
  OpenTelemetry auto-instrumentation exports HTTP and runtime metrics over OTLP to the
  shared stack, where the "EventHorizon Service" dashboard renders RED metrics and Node.js
  runtime health.
  **Satisfied by:** Observation Plane — `src/observation/tracing.ts` → OTLP →
  Prometheus/Grafana (`rhizome-observability`).

- **As an operator, I want the live feed to survive a brief database hiccup without me
  restarting anything, so that transient infrastructure blips don't create blind spots.**
  The change stream recovers from cursor errors with a persisted resume token and
  exponential backoff, replaying events inserted during the outage.
  **Satisfied by:** Observation Plane — `src/observation/changeStream.ts`,
  `src/observation/checkpoint.ts`.

---

## 3. Platform engineer

> *Whoever packages, deploys, scales, and operates EventHorizon.*

- **As a platform engineer, I want one container image that can run as either the server or
  the worker, so that I have a single artifact to build, scan, and promote.**
  A multi-stage `Dockerfile` produces a lean non-root image; the server is the default
  `CMD`, the worker overrides it (`node dist/processing/worker.js`).
  **Satisfied by:** `Dockerfile`; `k3s/server.yaml`, `k3s/worker.yaml`.

- **As a platform engineer, I want Kubernetes to know when a pod is actually healthy, so
  that liveness/readiness probes restart or hold traffic correctly.**
  `GET /healthz` pings MongoDB and returns `200 {status:"ok"}` or `503 {status:"degraded"}`,
  wired to both k3s probes.
  **Satisfied by:** `src/health.routes.ts`; `k3s/server.yaml` (probe config).

- **As a platform engineer, I want to scale throughput by adding workers, so that I can
  absorb load spikes without redesigning the pipeline.**
  Workers are competing consumers on `events.work` with `prefetch` backpressure; the k3s
  worker Deployment runs `replicas: 2` and is safe to scale because inserts are idempotent.
  **Satisfied by:** Processing Plane — `src/processing/worker.ts`, `queue.ts`;
  `k3s/worker.yaml`.

- **As a platform engineer, I want a pod restart to never silently drop events, so that
  routine k3s churn (evictions, rolling deploys, OOM kills) doesn't create data gaps.**
  The change-stream resume token is persisted to MongoDB and reloaded on startup, so a
  restarted pod replays missed inserts instead of re-anchoring at the oplog head.
  **Satisfied by:** Observation Plane — `src/observation/checkpoint.ts`; ADR 0013.

- **As a platform engineer, I want to follow a single event across all four planes when
  debugging, so that I can see where latency or failure actually occurs.**
  OpenTelemetry emits wide spans on every stage and propagates W3C trace context across the
  RabbitMQ boundary, producing one connected trace from HTTP ingest to WebSocket fanout.
  **Satisfied by:** Observation Plane — `src/observation/tracing.ts`; context propagation in
  `src/processing/queue.ts` + `src/processing/worker.ts`; ADR 0015, 0016.

- **As a platform engineer, I want EventHorizon's signals in the shared observability stack,
  so that it's monitored alongside my other services rather than through a bespoke per-app
  dashboard.**
  Traces, metrics, and logs are exported over OTLP to a collector endpoint configured by
  `OTEL_*` environment variables; the service identifies itself via `OTEL_SERVICE_NAME`.
  **Satisfied by:** `src/observation/tracing.ts`; `OTEL_*` config in `src/config.ts`.

- **As a platform engineer, I want to inject controlled faults on demand, so that I can
  verify the observability surfaces actually reflect real 4xx/5xx and failure traffic before
  relying on them.**
  `CHAOS_ERROR_RATE` makes the server throw after validation to produce genuine 500s, and the
  seed producer's `--error-rate` emits malformed ids to trigger genuine 422s; both default to
  0 and are off unless explicitly set.
  **Satisfied by:** Ingestion Plane — `src/config.ts`, `src/ingestion/event.routes.ts`;
  `src/seed/producer.ts`.

---

## 4. Maintainer

> *Whoever evolves, audits, and reasons about the system over time.*

- **As a maintainer, I want at-least-once delivery and competing consumers implemented
  explicitly against a real broker, so that the delivery guarantees are visible and auditable
  rather than buried in a job library's defaults.**
  RabbitMQ topology, prefetch, and `ack`-after-write are spelled out in code, so their
  trade-offs can be reviewed and tuned directly.
  **Satisfied by:** Processing Plane — `src/processing/queue.ts`, `worker.ts`; ADR 0003.

- **As a maintainer, I want retry and dead-lettering implemented by hand, so that the
  failure-handling behavior is auditable and modifiable at the AMQP level rather than opaque.**
  Application-level `x-retry-count` (max 3) drives republish-or-dead-letter via a DLX.
  **Satisfied by:** Processing Plane — `src/processing/worker.ts`, `queue.ts`; ADR 0005.

- **As a maintainer, I want one shared, schema-derived type to flow through every plane, so
  that a contract change propagates coherently across the whole multi-stage system.**
  `AppEvent` is `z.infer<>`-derived from the Zod schema and imported by every plane; no
  plane defines its own event shape.
  **Satisfied by:** `src/ingestion/event.schema.ts`; ADR 0012.

- **As a maintainer, I want an explicit, ordered graceful-shutdown sequence, so that the
  guarantee against message loss is verifiable rather than incidental.**
  Shutdown drains HTTP/WS, cancels the consumer, closes the change stream, then MongoDB,
  then the AMQP channel and connection — in that exact order.
  **Satisfied by:** `src/server.ts`, `src/processing/worker.ts`;
  [ARCHITECTURE.md](ARCHITECTURE.md#graceful-shutdown-sequence).

- **As a maintainer, I want queue depth, change-stream lag, and per-type throughput available
  as metrics, so that pipeline-internal health is alertable and historically queryable — not
  only visible live in the in-app dashboard.**
  Queue depth is scraped from RabbitMQ's own exporter; change-stream lag and per-type
  throughput are emitted as custom OTel metrics from the pipeline itself.
  **Satisfied by:** Observation Plane — custom OTel metrics in `src/observation/metrics.ts`
  and `src/processing/worker.ts`; ADR 0017.

---

See also: [ARCHITECTURE.md](ARCHITECTURE.md) · [SERVICES.md](SERVICES.md) ·
[API.md](API.md) · [DECISION_LOG.md](DECISION_LOG.md).
