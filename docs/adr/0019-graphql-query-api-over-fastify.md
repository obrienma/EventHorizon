# ADR 0019 — GraphQL Query API over the Storage Plane

**Status:** Accepted

---

## Context

EventHorizon's four planes (Ingestion → Processing → Storage → Observation) are write-path and push-path only. There is no read API over the `events` collection — the dashboard gets data exclusively via the WebSocket broadcast (`observation/wsServer.ts`), which is a live feed, not a queryable interface. There is no way to ask "give me the last 20 failed sensor events" or "show me every step of pipeline run X" without querying MongoDB directly.

EventHorizon already has a well-modeled, discriminated-union event schema (`ingestion/event.schema.ts`) that is a good fit for a GraphQL schema, and it has a real N+1 case (see below) once that mapping exists — worth solving properly rather than leaving latent.

**Does this violate the "four planes, one direction" invariant?** No. This is not a fifth stage in the pipeline — it doesn't sit between existing planes or feed back into them. It's an orthogonal read API over data already at rest in the Storage plane, the same relationship Observation's metrics polling (`observation/metrics.ts`) already has to MongoDB. Nothing about the ingestion → processing → storage → observation flow changes.

## Decision

Add a **GraphQL query API** (queries only — no mutations, no subscriptions) as a new Fastify plugin registered alongside the existing routes in `src/app.ts`, backed by:

- **Apollo Server** (`@apollo/server` + `@as-integrations/fastify`) as the GraphQL layer.
- **`dataloader`** for batching the one real N+1 case this schema has.
- A new `src/graphql/` directory: `schema.ts` (typeDefs), `resolvers.ts`, `loaders.ts`, `plugin.ts`.

Scope is deliberately narrow: expose read access to data EventHorizon already owns (the `events` collection, the in-memory stats used for `StatsPayload`). No cross-service call to Synapse-L4 is included in this phase — see Alternatives Considered and Consequences for why that's deferred rather than built now.

### Schema shape

```graphql
enum EventType { PIPELINE SENSOR APP }
enum EventStatus { PROCESSED FAILED }
enum Classification { NORMAL WARNING CRITICAL }

interface Event {
  id: ID!
  timestamp: String!
  source: String!
  status: EventStatus!
  processed: ProcessedMeta
}

type PipelineEvent implements Event {
  id: ID!
  timestamp: String!
  source: String!
  status: EventStatus!
  processed: ProcessedMeta
  pipelineId: String!
  step: String!
  stepStatus: String!
  durationMs: Int
}

type SensorEvent implements Event {
  id: ID!
  timestamp: String!
  source: String!
  status: EventStatus!
  processed: ProcessedMeta
  sensorId: String!
  metric: String!
  value: Float!
  unit: String!
}

type AppTelemetryEvent implements Event {
  id: ID!
  timestamp: String!
  source: String!
  status: EventStatus!
  processed: ProcessedMeta
  action: String!
  userId: String
}

type ProcessedMeta {
  receivedAt: String!
  enrichedAt: String!
  classification: Classification!
  tags: [String!]!
}

type PipelineRun {
  pipelineId: ID!
  steps: [PipelineEvent!]!
  latestStepStatus: String!
}

type Stats {
  totalProcessed: Int!
  failedCount: Int!
  queueDepth: Int!
  queueDepthStatus: String!
  processingRatePerSec: Float!
  changeStreamLagMs: Float!
}

type Query {
  event(id: ID!): Event
  events(type: EventType, status: EventStatus, limit: Int = 50): [Event!]!
  pipelineRuns(limit: Int = 20): [PipelineRun!]!
  pipelineRun(pipelineId: ID!): PipelineRun
  stats: Stats!
}
```

`Event` is a GraphQL interface over the same discriminated union `EventSchema` already models in Zod — the union tag (`type`) becomes the interface's `__resolveType` discriminant. This is a direct, honest mapping of an existing Zod discriminated union onto a GraphQL concept, not a new data model invented for the demo.

### The N+1 case (real, not manufactured)

`pipelineRuns` returns N distinct pipeline IDs. Each `PipelineRun.steps` field, resolved naively, would run its own `find({ "raw.payload.pipelineId": id })` query — N+1 queries for N pipeline runs in one request. A `DataLoader<string, PipelineEvent[]>` batches all requested pipeline IDs from a single GraphQL request into one `find({ "raw.payload.pipelineId": { $in: ids } })` call, groups the results in memory, and returns them keyed by ID in the order requested. `steps` and `latestStepStatus` both go through the same loader instance (one per request, per Apollo's per-request context pattern) so a query selecting both fields doesn't double-batch.

## Rationale

- **Apollo Server over Mercurius**: Mercurius is the more idiomatic choice for a Fastify-native app — it's a first-party Fastify plugin with less integration glue, and for this project's actual scale (single service, no schema registry, no team) it would be the lower-friction pick on pure engineering merit. Apollo Server is chosen instead for one concrete, checkable reason: **Apollo Federation — the multi-service pattern this ADR explicitly defers rather than rules out (see Alternatives, Consequences) — is built on Apollo Server.** If Synapse-L4 ever gains a real read endpoint and federating it into this graph becomes a live need, staying on Apollo Server now avoids a server-library migration later; Mercurius has a different federation story of its own, and switching mid-project would be pure waste. This is a narrow bet on one specific future path, not a claim that Apollo Server is generally superior — if that federation need never materializes, Mercurius would have been the better call, and that's a perfectly fine outcome for a query API this small.
- **DataLoader over ad-hoc batching**: DataLoader is the reference implementation the GraphQL ecosystem (including Apollo's own docs) uses to solve N+1. Using it, rather than hand-rolling a batch map, means the request-scoped caching and batch-scheduling semantics are the well-tested standard ones, not a bespoke reimplementation with its own edge cases.
- **Queries only, no mutations**: `/events` (HTTP POST ingestion) already exists and is schema-validated by Zod at the ingestion plane. Re-exposing event creation through a GraphQL mutation would mean validating the same shape twice through two different systems for no operational benefit — added surface area with no corresponding need, which fails the same "name the mechanism, don't add unearned scope" test as any other unbacked claim about what a system does.
- **No subscriptions**: `wsServer.ts` already solves live push. A GraphQL subscription over the same data would be a second live-push mechanism doing the same job with no consumer for it — clear "wait until it hurts" territory.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Mercurius (Fastify-native GraphQL) | First-party Fastify plugin, less integration surface; lower friction at this project's current scale | Doesn't carry Federation forward if that becomes a real need later (see Rationale above); would mean a server-library migration at that point |
| GraphQL Yoga | Framework-agnostic, modern, good DX | Same Federation gap as Mercurius; no distinct advantage over Apollo Server for this purpose |
| Federated schema across EventHorizon + Synapse-L4 now (Apollo Federation gateway) | Would demonstrate the exact multi-service pattern Apollo is known for | Synapse-L4 currently exposes no per-source read endpoint (`main.py` only wires up `POST /ingest` and `GET /metrics` — see `src/api/ingest.py`). Building a read endpoint on Synapse-L4 solely to have something to federate is scope invented to justify the demo, not scope driven by a real need. Deferred — see Consequences. |
| Hand-rolled batching (`Map<string, Promise>` keyed cache, no DataLoader dependency) | Zero new dependency | Reinvents DataLoader's request-scoped caching and batch-scheduling (`process.nextTick` tick coalescing) worse, for no benefit — the whole point is to show the standard tool used correctly |

## Consequences

- New dependencies: `@apollo/server`, `@as-integrations/fastify`, `graphql`, `dataloader`. None touch the ingestion/processing/storage hard invariants — this is additive, read-only surface.
- `docs/adr/0019` becomes the reference point for "why GraphQL, why Apollo, why here" if this decision needs revisiting or explaining later.
- **Deferred, explicitly**: federating Synapse-L4 into this graph. The trigger for revisiting this would be Synapse-L4 gaining a real read endpoint driven by its own needs (e.g., a dashboard or debugging need for "show me the Axiom for source X"), at which point extending this graph to it is a natural Phase 2 rather than invented scope. Do not build that endpoint speculatively just to unlock this ADR.
- Query complexity/depth limiting is out of scope for this phase (no public exposure, single consumer). If this API is ever exposed beyond local/demo use, that becomes a real requirement — noted here so it isn't silently forgotten, not implemented preemptively.
- Confidence: **High** on the mapping (discriminated union → GraphQL interface, real N+1 → DataLoader). **Medium** on Apollo Server's Fastify integration ergonomics specifically — `@as-integrations/fastify` is a thinner, less battle-tested integration than Apollo's Express path; this should be validated early in implementation rather than assumed.

### Measured

- **Apollo/Fastify integration confidence: Medium → High.** The Phase 0 boot check (`apollo.start()` → `app.register(fastifyApollo(apollo))` → live `curl -X POST /graphql`) and every phase after it hit no version mismatches, no missing drain-plugin wiring, no context-function surprises. The thinner-integration risk called out above didn't materialize for this project's scope.
- **N+1 fix, measured directly, not just implemented:** a naive per-field-instantiated loader made **5** Mongo queries for **5** `pipelineRuns` in one request; the per-request `DataLoader` made **1** (`find({ ..., pipelineId: { $in: [...] } })`), confirmed by patching `Collection.prototype.find` to count actual invocations. Full before/after in `docs/journal.md#phase-23-graphql-query-api-phase-2-pipelineruns--dataloader`.
- **One schema gap found and closed before implementation:** the original schema block defined `ProcessedMeta` but never attached it as a field anywhere, while the companion plan's Phase 1 instructions assumed `processed.*` was readable. Resolved by adding a nullable `processed: ProcessedMeta` field to the `Event` interface and all three concrete types (already reflected in the Schema shape above) — confirmed with the user before writing resolver code, rather than the schema silently drifting from what got implemented.
- **One incidental infra finding, out of scope for this ADR:** local verification hit a stale replica-set hostname after a `docker compose down`/`up` cycle, caused by `docker-compose.yml` not pinning the Mongo service's `hostname:`. Fixed locally via `rs.reconfig()`; not fixed in the compose file since it's unrelated to this decision. Will recur until addressed separately.
