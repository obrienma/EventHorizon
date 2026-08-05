---
id: eventhorizon-2026-07-06T0915-graphql-resolvers
repo: eventhorizon
title: "GraphQL Query API, Phase 1 (Real Schema/Resolvers)"
date: 2026-07-06
phase: 22
tags: [graphql, enum-value-maps, type-narrowing, adr, wsl, code-reuse]
files: [src/graphql/schema.ts, src/graphql/resolvers.ts, src/observation/metrics.ts, docs/adr/0019-graphql-query-api-over-fastify.md]
---

### Pattern: GraphQL Enum Value Maps Instead of Manual Case Conversion

The Zod schema and MongoDB documents use lowercase internal values (`"pipeline"`, `"processed"`, `"normal"`) while the ADR's schema specifies uppercase GraphQL enum names (`PIPELINE`, `PROCESSED`, `NORMAL`) as is conventional for GraphQL SDL. Rather than writing resolver code to uppercase output values and lowercase input args, `resolvers.ts` exports `EventType`/`EventStatus`/`Classification` value maps (e.g. `{ PIPELINE: "pipeline", SENSOR: "sensor", APP: "app" }`) — Apollo translates between the external enum name and the internal value automatically in both directions. Query arg filters (`events(type: SENSOR)`) and field resolvers (`status: (doc) => doc.status`) both pass the internal lowercase string straight through with zero case-conversion logic.

### Pattern: Extract Shared Query Logic Instead of Duplicating It

`Query.stats` needed the same totals/queueDepth/rate/lag assembly that `startMetrics`'s broadcast interval already computed. Rather than reimplementing that aggregation in `resolvers.ts`, `metrics.ts` now exports `getStatsSnapshot(): Promise<StatsPayload>` — the interval's body was reduced to `await getStatsSnapshot()` followed by the broadcast call, and the GraphQL resolver calls the same function. One implementation of "what counts as the current stats," two callers.

### Anti-Pattern Avoided: Type Narrowing Silently Assumed Correct

`Event.__resolveType` tells GraphQL which concrete resolver map to call (`PipelineEvent`, `SensorEvent`, `AppTelemetryEvent`), but it doesn't narrow TypeScript's view of `doc.raw` inside those maps — the parent object is still typed as the full `StoredEvent` union. `pipelinePayload()`/`sensorPayload()`/`appPayload()` helpers narrow explicitly and throw if the discriminant doesn't match the expected type. The throw is unreachable in correct operation (it would mean `__resolveType` and a field resolver disagree), but it makes the payload accessors total functions rather than ones that silently return `undefined` or produce a runtime type error deeper in the call stack.

### Decision: Add `processed: ProcessedMeta` to the Event Interface Before Writing Resolvers

ADR 0019's schema defined a `ProcessedMeta` GraphQL type but never referenced it as a field anywhere, while the companion plan's Phase 1 instructions explicitly said field resolvers should read from `processed.*` on the stored document — an internal inconsistency between the ADR and its own implementation plan. Rather than silently picking a placement, this was surfaced to the user before writing any resolver code; the resolved design adds a nullable `processed: ProcessedMeta` field to the `Event` interface and all three concrete types (null for `status: FAILED` documents, since failed `StoredEvent`s have no `processed` sub-document at all). ADR 0019 was amended in place — it is still `Proposed`, so no formal revision-history entry was needed.

### Decision: Hard-Cap `events(limit)` Regardless of Client Input

The schema's `events(limit: Int = 50)` argument is client-supplied. Without a ceiling, a client requesting `limit: 1000000` would force an unbounded collection scan. `resolvers.ts` clamps with `Math.min(args.limit ?? 50, 200)` — the default stays ADR-specified, but 200 is a hard floor no request can exceed, matching the ADR's Consequences note that complexity/depth limiting is deferred but shouldn't be silently forgotten.

### Challenge: Verification Under WSL2 Memory Pressure

None blocking. The live verification (Fastify `inject()` against real Mongo data, bypassing RabbitMQ/worker entirely by writing `StoredEvent`s directly via `saveEvent`/`saveFailedEvent`) surfaced one environment risk worth recording: running the full `server.ts` + `worker.ts` dev processes simultaneously pushed WSL2 memory to 6.4/7.6GB used with swap fully exhausted, causing both processes to hang silently past their normal ~2s boot time. Both were killed before triggering the OOM crash this project's memory notes already warn about, and re-verification used a single lightweight script (`app.inject()`, no live `.listen()`, no OTel/RabbitMQ bootstrap) instead — a lighter path worth defaulting to for future verification passes in this environment.
