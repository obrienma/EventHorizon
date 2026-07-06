# EventHorizon — Project Context

> **Dual-LLM project**: Primary AI assistant is **Claude Code** (this file). GitHub Copilot context lives in `.github/copilot-instructions.md`. Keep both in sync when updating project context.

EventHorizon is a **Reactive Data Plane** — a TypeScript/Node.js event-driven telemetry pipeline. Its purpose is practicing advanced backend patterns, not domain logic. The plumbing IS the project.

---

## Architecture: Four Named Planes

```
Ingestion Plane  →  Processing Plane  →  Storage Plane  →  Observation Plane
src/ingestion/       src/processing/       src/storage/       src/observation/
```

Data flows **one direction only**. Nothing flows backwards between planes.

| Plane | Responsibility | Key files |
|---|---|---|
| **Ingestion** | HTTP entry, Zod validation, publish to RabbitMQ | `ingestion/event.schema.ts`, `ingestion/event.routes.ts` |
| **Processing** | AMQP consumer, enrich, classify, ack/nack/retry | `processing/queue.ts`, `processing/worker.ts`, `processors/` |
| **Storage** | Append-only MongoDB writes, idempotent inserts | `storage/db.ts`, `storage/event.repository.ts` |
| **Observation** | Change stream → WebSocket push, metrics polling | `observation/changeStream.ts`, `observation/wsServer.ts`, `observation/metrics.ts` |

---

## Hard Invariants — Never Violate These

- **Append-only storage**: MongoDB documents are NEVER updated after insert. `processed` sub-document is written once by the worker on first successful processing.
- **Idempotent inserts**: Unique index `{ "raw.id": 1 }` on the `events` collection. Duplicate key errors (`code 11000`) are silently ignored — not re-thrown.
- **`AppEvent` is the shared contract**: All planes import event types from `src/ingestion/event.schema.ts`. No plane defines its own event shape.
- **`z.infer<>` only**: Types are always derived from Zod schemas — never written by hand alongside a schema.
- **Graceful shutdown order**: Fastify stop → cancel AMQP consumer → finish in-flight message → close change stream → close MongoDB → close AMQP channel + connection → `process.exit(0)`. This exact order prevents message loss.

---

## Stack

| Layer | Tech | Version |
|---|---|---|
| Language | TypeScript strict, NodeNext modules | 6.x |
| Framework | Fastify | 5.x |
| Message broker | RabbitMQ via `amqplib` | 3.x / 0.10.x |
| Database | MongoDB | 7.x |
| Real-time | `@fastify/websocket` (raw WS, no socket.io) | 11.x |
| Validation | Zod (shared across all planes) | 4.x |
| Testing | Vitest + mongodb-memory-server | latest |
| Runtime | Node.js ESM (`"type": "module"`) | 20+ |

---

## RabbitMQ Topology (declared in `processing/queue.ts`)

```
events (topic exchange)
  └── events.work (durable queue, DLX → events.dlx, TTL 30s)
        └── on nack/TTL → events.dlx (fanout exchange)
              └── events.dead (durable queue)

Routing keys: events.pipeline | events.sensor | events.app
Work queue binding: events.# (catches all)
Backpressure: channel.prefetch(WORKER_PREFETCH env var, default 5)
```

Topology declaration is **idempotent** — safe to call on every startup.

## Worker Retry Logic

Application-level retry via `x-retry-count` message header:
- On error: if `x-retry-count < 3` → republish with incremented count
- On error: if `x-retry-count >= 3` → `channel.nack(msg, false, false)` → dead-lettered to `events.dead`
- On success: `channel.ack(msg)`

---

## WebSocket Message Protocol (`observation/wsServer.ts`)

```ts
type WsMessage =
  | { type: "event"; data: StoredEvent }         // fired per change stream insert
  | { type: "stats"; data: StatsPayload }        // broadcast every STATS_PUSH_INTERVAL_MS
  | { type: "ping" }                             // client responds with "pong"
```

`StatsPayload` includes: `totalProcessed`, `failedCount`, `queueDepth`, `queueDepthStatus` (`ok`/`warning`/`critical`), `processingRatePerSec`, `changeStreamLagMs`, `eventTypeDistribution`.

Queue depth thresholds: `QUEUE_DEPTH_WARNING` (default 50) → yellow, `QUEUE_DEPTH_CRITICAL` (default 200) → red.

---

## Environment Variables

All vars in `.env.example`. Validated via Zod in `src/config.ts` — process exits on startup if any are missing/invalid.

Key vars: `MONGO_URI`, `MONGO_DB_NAME`, `RABBITMQ_URL`, `RABBITMQ_MANAGEMENT_URL`, `EXCHANGE_NAME`, `QUEUE_NAME`, `DEAD_LETTER_QUEUE`, `WORKER_PREFETCH`, `QUEUE_DEPTH_WARNING`, `QUEUE_DEPTH_CRITICAL`, `STATS_PUSH_INTERVAL_MS`, `METRICS_RATE_WINDOW_MS`, `EVENT_DISTRIBUTION_POLL_MS`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`.

---

## Commands

```bash
npm run infra        # docker compose up -d (MongoDB :27017 + RabbitMQ :5672, UI :15672)
npm run infra:down   # docker compose down
npm run dev          # start Fastify server (tsx src/server.ts)
npm run worker       # start AMQP consumer in separate process
npm run seed         # fake event generator (tsx src/seed/producer.ts)
npm test             # vitest run
npm run test:watch   # vitest watch
npm run typecheck    # tsc --noEmit
```

---

## Testing Conventions

- Tests colocated with source: `foo.test.ts` next to `foo.ts`
- Repository tests: `mongodb-memory-server` (no live Mongo needed)
- Route tests: Fastify `inject()` + `vi.mock()` for `publishEvent()`
- Processor tests: pure unit (no I/O)
- **Not automated**: change streams (needs replica set), WS broadcast, graceful shutdown
- Full strategy: [docs/TESTING.md](docs/TESTING.md)

---

## Detailed Documentation

See `docs/` — ARCHITECTURE.md, SERVICES.md, API.md, DEV_GETTING_STARTED.md, TESTING.md, DECISION_LOG.md, diagrams/OVERVIEW.md.

---

## Journal

Engineering journal entries live in `docs/journal.md` — one `## Phase N — <Name> — YYYY-MM-DD` block per phase, with a `Files:` line and `### Pattern:`, `### Anti-Pattern Avoided:`, `### Challenge:`, `### Decision:` sections written as declarative prose (no Q:/A: blocks).

Spaced-repetition probes (Cloze, Basic, and Image Occlusion cards) live in `docs/probes/phase-N-<name>.md`, one file per phase block, deck `Rhizome::EventHorizon`. Each probe's `See:` field links back to its `docs/journal.md#phase-N-<name>` anchor.

Entries that touch the integration boundary with `~/dev/rhizome-observability` carry a `cross-ref: observability` marker (in both the journal heading and the corresponding probe frontmatter).

`LEARNING_LOG.md` has been migrated and superseded by `docs/journal.md` + `docs/probes/`.

---

## Current Build Status

**Completed:** project scaffold, tsconfig, docker-compose, .env, vitest config, README, all docs, copilot-instructions.md, CLAUDE.md, `src/config.ts`, `src/ingestion/event.schema.ts`, `src/global.d.ts`, `src/server.ts`, `src/ingestion/event.routes.ts`, `src/processing/queue.ts`, `src/processing/worker.ts`, `src/processors/enrich.ts`, `src/processors/classify.ts`, `src/storage/db.ts`, `src/storage/event.repository.ts`, `src/observation/changeStream.ts`, `src/observation/wsServer.ts`, `src/observation/metrics.ts`, `src/observation/checkpoint.ts`, `src/observation/tracing.ts` (OTel Phase 3 — wide spans on all four pipeline stages, RabbitMQ context propagation, parse-failure span events).

**Phase 16 (2026-06-14):** Live-validated the full OTel pipeline against the `rhizome-observability` stack (Tempo/Loki/Prometheus/Grafana). Fixed a `Buffer.byteLength` bug in `event.routes.ts` that was masked by optional-chaining short-circuit in `app.inject()` tests (`a9e2e4a`). Built the "EventHorizon Service" Grafana dashboard (RED metrics + Node.js runtime health) entirely from existing auto-instrumentation metrics — no new instrumentation code.

**Phase 17 (2026-06-14):** Added opt-in fault injection for dashboard demo traffic — `CHAOS_ERROR_RATE` (server, `config.ts`/`event.routes.ts`) throws after validation to produce real 500s; `--error-rate` (seed producer) sends a malformed `id` to trigger real 422s. Both default to 0 and are off unless explicitly set. Live-verified mixed 202/422/500 traffic in Tempo and Prometheus, and added a "Recent Traces" TraceQL table panel to the "EventHorizon Service" dashboard.

**Phase 18 (2026-06-15):** Exported pipeline-internal signals as custom OTel instruments so Grafana (not just the in-app dashboard) can trend/alert on them — `events.processed` and `events.failed` Counters labeled by `event.type` (Prometheus `events_processed_total{event_type=…}` / `events_failed_total{event_type=…, failure_reason=…}`, in `worker.ts`; `events.failed` is the async-failure/dead-letter signal the HTTP 5xx panel can't see, with `failure_reason` ∈ {parse_error, schema_error, processing_error}) and `eventhorizon.change_stream.lag` ObservableGauge (Prometheus `eventhorizon_change_stream_lag_milliseconds`, in `metrics.ts`). All reuse the env-configured `MeterProvider` (no new wiring); `queueDepth` is intentionally left to RabbitMQ's own exporter (`rabbitmq_prometheus`, enabled by default in the image — `docker-compose.yml` now publishes `15692` on the host; the matching Prometheus scrape job is the only remaining observability-repo step). Live-verified `events_processed_total` (25/35/36 split by type) and the lag gauge (0ms) in Prometheus. Refines ADR 0016 → ADR 0017. Also reframed `USER_STORIES.md` persona 4 (learner → Maintainer) and added observability/fault-injection stories.

**Phase 19 (2026-06-15):** Filled the intentional-friction TODO stubs that left 9 tests red — `classify.ts` (pipeline/sensor branches), `computeRatePerSec` in `metrics.ts` (read-time-filtered sliding window), and `saveEvent` in `event.repository.ts` (idempotent `insertOne` with `11000` swallow, mirroring `saveFailedEvent`). Also fixed the `classify.test.ts` `makeEvent` helper with a `DistributiveOmit` (plain `Omit` doesn't distribute over a discriminated union). Suite now 44/44 green; `tsc --noEmit` clean.

**Phase 20 (2026-07-04):** Fixed an unbounded-memory bug in `broadcast()` (`wsServer.ts`) flagged while working the Synapse-L4 integration boundary — `readyState` was checked before `socket.send()`, but not `bufferedAmount`, so a stalled WS client (e.g. Synapse-L4's read loop) let the server queue outbound bytes without limit. Added a skip/terminate threshold pair (`WS_BUFFERED_AMOUNT_SKIP` default 1MB, `WS_BUFFERED_AMOUNT_TERMINATE` default 5MB, both in `config.ts`/`.env.example`), mirroring the `WORKER_PREFETCH`/`QUEUE_DEPTH_*` bounded-backpressure pattern already used at the RabbitMQ layer. Durable-delivery alternatives (Mongo change-stream reuse, a new RabbitMQ queue) were considered and rejected — see ADR 0018 — in favor of accepting documented at-most-once delivery to WS subscribers. Suite still 44/44 green; `tsc --noEmit` clean.

**Phase 21 (2026-07-06):** Started the GraphQL query API over the Storage plane per ADR 0019 (`.claude/plans/graphql-query-api.md` — Phase 0 of 4). Added `@apollo/server`, `@as-integrations/fastify`, `graphql`, `dataloader`; scaffolded `src/graphql/{schema,resolvers,loaders,plugin}.ts` with a minimal `Query.health` field, wired `registerGraphQL(app)` into `app.ts` alongside `registerWsServer`. Live-verified `/graphql` boots and responds (`{"data":{"health":"ok"}}`) against local infra; no rough edges hit in the Apollo/Fastify integration despite the ADR's Medium-confidence note. `loaders.ts` and the real schema/resolvers are intentionally still stubs — filled in Phases 1–2. Suite still 44/44 green; `tsc --noEmit` clean.

**Phase 22 (2026-07-06):** GraphQL plan Phase 1 — real schema and resolvers over the Storage plane (`docs/adr/0019`). Fixed a schema/plan inconsistency first: ADR 0019 defined a `ProcessedMeta` type but never attached it as a field anywhere; added `processed: ProcessedMeta` (nullable) to the `Event` interface and all three concrete types, resolved to `null` for `status: FAILED` documents (confirmed with user before implementing). `resolvers.ts` implements `Query.event`, `Query.events` (type/status/limit filter, 200-doc hard cap regardless of client-supplied limit), `Event.__resolveType`, and field resolvers on `PipelineEvent`/`SensorEvent`/`AppTelemetryEvent` reading `raw.payload.*`/`processed.*` from the stored document — enum values pass through as-is via GraphQL enum value maps (`EventType`/`EventStatus`/`Classification`), no manual case-conversion code. `Query.stats` reuses a newly-extracted `getStatsSnapshot()` in `metrics.ts` (previously inlined in the WS broadcast interval) rather than re-querying — one implementation of the stats assembly, not two. `pipelineRuns`/`pipelineRun` intentionally still throw `Not implemented` (Phase 2). Live-verified against real Mongo data (Fastify `inject()`, no live HTTP listen) — enum uppercasing, `processed` nesting, and inline-fragment fields on `SensorEvent` all resolved correctly. Suite still 44/44 green; `tsc --noEmit` clean.

**Phase 23 (2026-07-06):** GraphQL plan Phase 2 — `pipelineRuns`/`pipelineRun` and the DataLoader N+1 fix (`docs/adr/0019`). `loaders.ts` exports `createPipelineStepsLoader()`, a `DataLoader<string, StoredEvent[]>` that batches all `.load(pipelineId)` calls made during one GraphQL request into a single `find({ "raw.type": "pipeline", "raw.payload.pipelineId": { $in: [...] } })`, grouped by id and returned in request order (DataLoader's own ordering requirement). `plugin.ts`'s Apollo context function creates one loader instance per request — a shared/global instance would leak cached results across unrelated requests. `resolvers.ts`: `Query.pipelineRuns` (`distinct()` over `raw.payload.pipelineId`, capped at 200 like `events`), `Query.pipelineRun` (existence check, returns `null` if the id doesn't exist), and a new `PipelineRun` resolver map where `steps`/`latestStepStatus` both call `context.pipelineStepsLoader.load()` — reusing the same `PipelineEvent` field resolvers from Phase 1 for the returned steps (no duplicate mapping code). Live-verified the actual N+1 fix, not just the code: a naive per-field-instantiated loader made 5 Mongo queries for 5 pipeline runs; the per-request DataLoader made 1. Hit and fixed an unrelated local infra snag along the way — the Mongo container's replica-set config pointed at a stale container hostname after a `docker compose down`/`up` cycle (compose file doesn't pin `hostname:`); reconfigured the single-node replica set to the new hostname rather than wiping the data volume. Suite still 44/44 green; `tsc --noEmit` clean.

**Phase 24 (2026-07-06):** GraphQL plan Phase 3 — ADR closeout. `docs/adr/0019` flipped `Proposed` → `Accepted`, with a new "Measured" subsection under Consequences recording the Apollo/Fastify integration confidence upgrade (Medium → High, no rough edges across all three implementation phases), the N+1 measurement (5 queries naive vs. 1 batched), the `ProcessedMeta` schema gap found and closed in Phase 1, and the out-of-scope replica-set hostname finding from Phase 2. `docs/probes/phase-23-dataloader-n-plus-1.md` (written during Phase 2) already covers the DataLoader mechanism, ordering requirement, and both infra/testing challenges — no additional probe needed for closeout itself. README's GraphQL roadmap entry promoted from "Planned" to the completed phase history. All four GraphQL plan phases (0–3) now done; `.claude/plans/graphql-query-api.md`'s only remaining out-of-scope item (federating Synapse-L4) stays explicitly deferred per ADR 0019 Consequences. Also added `blog/event-horizon-2026-07-06-graphql-and-the-n-plus-1-we-measured.md` (optional per the plan) covering the ADR self-contradiction, the enum value map trick, and the measured N+1 story.

**Build order: top-down** (start at the entry point, add each layer as it's called)

**Not yet implemented** (in order):
1. ~~`src/processing/queue.ts` — RabbitMQ topology + real `publishEvent()`~~ ✓
2. ~~`src/processing/worker.ts` + `processors/enrich.ts` + `processors/classify.ts`~~ ✓
3. ~~`src/storage/db.ts` + `src/storage/event.repository.ts`~~ ✓
4. ~~`src/observation/changeStream.ts` + `src/observation/wsServer.ts`~~ ✓
5. ~~`src/observation/metrics.ts`~~ ✓
6. ~~`src/seed/producer.ts`~~ ✓
7. ~~`src/dashboard/index.html`~~ ✓
8. Tests colocated per layer (Fastify inject + vi.mock → real mongodb-memory-server at bottom)
9. ~~`src/observation/changeStream.ts` — resume token recovery + exponential backoff~~ ✓
10. ~~`src/observation/checkpoint.ts` — durable resume token persistence (k3s pod-restart safe)~~ ✓
11. ~~`Dockerfile` — multi-stage build, non-root runner, single image / two entry points~~ ✓
12. ~~`src/health.routes.ts` — dependency-aware `/healthz` endpoint for k3s liveness/readiness probes~~ ✓
13. ~~`k3s/` manifests — namespace, ConfigMap, Secret, server Deployment+Service, worker Deployment~~ ✓

**Tests written so far:**
- `src/processors/enrich.test.ts` ✓
- `src/processors/classify.test.ts` ✓
- `src/storage/event.repository.test.ts` ✓ (mongodb-memory-server)
- `src/ingestion/event.routes.test.ts` ✓ (Fastify inject + vi.mock)
- `src/processing/worker.test.ts` ✓ (fixed: Zod v4 UUID validation — test fixture used non-RFC-4122 UUID)
- `src/observation/metrics.test.ts` ✓ (vi.useFakeTimers + vi.setSystemTime for deterministic rate/lag)

---

## Claude Code Workflow Notes

- **Work one step at a time** and pause for confirmation before moving to the next build step.
- **Commit after each logical step** — the user commits manually; don't push.
- **Don't add features beyond what's asked.** No extra error handling, no extra abstractions, no unrequested refactors.
- **No doc files** unless explicitly requested. Update `CLAUDE.md` Build Status section after each completed step.
- **Maintain `docs/journal.md`**: After each phase, append a new `## Phase N — <Name> — YYYY-MM-DD` block with `### Pattern:`, `### Anti-Pattern Avoided:`, `### Challenge:`, `### Decision:` sections in declarative prose. Add corresponding spaced-repetition cards to `docs/probes/phase-N-<name>.md` (see Journal section above).
- TypeScript strict mode means all nullable paths must be handled — don't use `!` non-null assertions unless provably safe.
- ESM (`"type": "module"`) — all imports need explicit `.js` extensions when importing local files (TypeScript resolves `.ts` → `.js` at runtime with NodeNext).
- Update the Build Status section in this file after each completed step.

## ADR files
Create decision logs according to https://martinfowler.com/bliki/ArchitectureDecisionRecord.html
