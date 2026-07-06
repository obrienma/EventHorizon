# Plan: GraphQL Query API over EventHorizon's Storage Plane

Companion implementation plan for ADR 0019.

Reference: `docs/adr/0019-graphql-query-api-over-fastify.md` exists (Proposed)
before Phase 1 starts. Read `CLAUDE.md` first — this plan must not violate the
four-planes-one-direction invariant or the append-only storage invariant.

---

## Phase 0 — Dependencies and scaffolding

**Goal:** New packages installed, empty module wired into `app.ts`, server boots.

- `npm install @apollo/server @as-integrations/fastify graphql dataloader`
- Create `src/graphql/schema.ts`, `src/graphql/resolvers.ts`, `src/graphql/loaders.ts`, `src/graphql/plugin.ts`
- `plugin.ts` exports `registerGraphQL(app: FastifyInstance): Promise<void>`, called from `app.ts` the same way `registerWsServer` is
- Minimal schema first: just `type Query { health: String! }` returning `"ok"` — confirm the Fastify + Apollo integration actually boots and `/graphql` responds before writing real resolvers

**Acceptance:** `curl -X POST localhost:3000/graphql -H 'content-type: application/json' -d '{"query":"{ health }"}'` returns `{"data":{"health":"ok"}}`.

**Probe-worthy moment:** if `@as-integrations/fastify` has rough edges (per the ADR's Medium-confidence note), this is where they show up. Document what actually happened in `docs/probes/phase-N-graphql-scaffold.md` if it's not a straight line.

---

## Phase 1 — Read schema over existing data

**Goal:** Full schema from the ADR, resolvers backed directly by MongoDB (no loader yet).

- `schema.ts`: full typeDefs from the ADR (`Event` interface, `PipelineEvent`/`SensorEvent`/`AppTelemetryEvent`, `ProcessedMeta`, `Stats`, `Query`)
- `resolvers.ts`:
  - `Query.event(id)` → `getDb().collection(EVENTS_COLLECTION).findOne({ "raw.id": id })`
  - `Query.events(type, status, limit)` → filtered `find()`, default `limit: 50`, hard cap e.g. 200 to avoid an unbounded scan from a client-supplied limit
  - `Query.stats` → adapt the existing `computeRatePerSec` / stats-assembly logic already in `observation/metrics.ts` — reuse it, don't reimplement it
  - `Event.__resolveType` → maps `raw.type` (`"pipeline" | "sensor" | "app"`) to `PipelineEvent | SensorEvent | AppTelemetryEvent`
  - Field resolvers on each concrete type read from `raw.payload.*` and `processed.*` on the stored document — reuse `StoredEvent` / `AppEvent` types from `ingestion/event.schema.ts` directly, do not redeclare shapes
- Leave `pipelineRuns` / `pipelineRun` unimplemented (throw `Not implemented — see Phase 2`) so Phase 1 ships a working, honest subset rather than a half-wired Phase 2

**Acceptance:** A query selecting `events(type: SENSOR, limit: 5) { id source ... on SensorEvent { metric value } }` returns real data from a locally seeded DB (`npm run seed`).

---

## Phase 2 — `pipelineRuns` and the DataLoader

**Goal:** The actual N+1 demonstration.

- `loaders.ts`: `createPipelineStepsLoader()` returning `new DataLoader<string, PipelineEvent[]>(async (pipelineIds) => { ... })`
  - Single query: `find({ "raw.type": "pipeline", "raw.payload.pipelineId": { $in: pipelineIds } })`
  - Group results by `pipelineId` in memory, return in the same order as the input `pipelineIds` array (DataLoader requires this — mismatched order is the most common DataLoader bug, worth a comment noting it)
- Loader instance created **per-request** in the Apollo context function (`context: async () => ({ pipelineStepsLoader: createPipelineStepsLoader() })`) — a shared/global loader would leak cached results across unrelated requests, which is the second most common DataLoader bug
- `resolvers.ts`:
  - `Query.pipelineRuns(limit)` → distinct `pipelineId` values from the events collection (`distinct("raw.payload.pipelineId", { "raw.type": "pipeline" })`), sliced to `limit`
  - `Query.pipelineRun(pipelineId)` → same shape, single ID
  - `PipelineRun.steps(parent, _, context)` → `context.pipelineStepsLoader.load(parent.pipelineId)`
  - `PipelineRun.latestStepStatus` → derived from the loaded steps (max by timestamp), not a separate query

**Acceptance — the actual demo:** temporarily log a counter in the Mongo query path (or watch `docker logs` / Mongo's own query log). Run a `pipelineRuns(limit: 10) { pipelineId steps { step stepStatus } }` query:
- **Before the loader is wired to per-request context correctly:** confirm you can *reproduce* N+1 by temporarily instantiating the loader per-field instead of per-request, and watch the query count scale with N.
- **After:** confirm exactly one `$in` query regardless of N.

This before/after is the artifact worth writing up in the blog series (`blog/`) — it's the concrete "I caused N+1 on purpose, measured it, then fixed it" story, not "I read that DataLoader solves N+1."

---

## Phase 3 — ADR closeout and writeup

**Goal:** ADR 0019 transitions `Proposed` → `Accepted`; journal/probe artifacts exist.

- Update `docs/adr/0019-graphql-query-api-over-fastify.md`: Status → Accepted, add a short "Measured" subsection under Consequences (query count before/after, any surprises in Apollo/Fastify integration vs. the Medium-confidence note)
- `docs/probes/phase-N-graphql-dataloader.md` following the existing probe format — this is the one most worth polishing, since it's the concrete "caused N+1 on purpose, measured it, then fixed it" story rather than an assertion that DataLoader was used
- Optional, only if it doesn't strain the "don't expand scope" principle: a short blog entry in `blog/` in the existing dated style, since the series already narrates architectural decisions as they're made

**Explicitly out of scope for this plan:** federating Synapse-L4 into the graph. Do not start this without a real trigger — see ADR 0019 Consequences.
