---
id: eventhorizon-2026-07-06T0930-dataloader-n-plus-1
repo: eventhorizon
title: "GraphQL Query API, Phase 2 (pipelineRuns + DataLoader)"
date: 2026-07-06
phase: 23
tags: [graphql, dataloader, n-plus-1, batching, mongodb, docker]
files: [src/graphql/loaders.ts, src/graphql/plugin.ts, src/graphql/resolvers.ts]
---

### Pattern: DataLoader Batches Per-Request, Not Per-Field

`PipelineRun.steps` and `PipelineRun.latestStepStatus` both need the same pipeline's steps. Resolved naively (one `find()` per field per run), N pipeline runs in one request cost N (or 2N) queries. `createPipelineStepsLoader()` returns a `DataLoader<string, StoredEvent[]>` whose batch function fires once per event-loop tick with every `pipelineId` requested so far, issuing one `find({ ..., pipelineId: { $in: [...] } })` regardless of how many `.load()` calls preceded it. DataLoader doesn't run its batch function immediately when `.load()` is called — it queues the key and schedules the batch function on the microtask queue (via `process.nextTick`/`Promise.resolve().then()`). Every `.load()` call made during the same GraphQL request, before that microtask fires, gets collected into one array of keys, and the batch function runs once with all of them. This only works if all N runs' `steps` resolvers execute within the same tick using the same loader instance — a fresh loader per field call would batch nothing. Apollo's context function (`plugin.ts`) creates exactly one loader per incoming request; sharing one loader across requests would leak one request's cached results into another's response.

### Anti-Pattern Avoided: Reordering the Batch Result

DataLoader requires the array returned by the batch function to be the same length and in the same order as the keys array it was given — index *i* of the result answers index *i* of the request, not "whichever id happened to match." The batch function groups matching documents into a `Map<pipelineId, StoredEvent[]>` first, then explicitly maps back over the original `pipelineIds` array (`pipelineIds.map((id) => byPipelineId.get(id) ?? [])`) rather than returning the grouped map's values directly — Map iteration order isn't guaranteed to match the request order, and even if it happened to for this data, that's not a contract to rely on.

### Decision: Reuse the Phase 1 `PipelineEvent` Resolvers for `PipelineRun.steps`

`PipelineRun.steps: [PipelineEvent!]!` is a concrete list type, not the `Event` interface — so GraphQL applies the existing `PipelineEvent` resolver map (written in Phase 1 for `Query.events`) to each loaded `StoredEvent` with no new field-mapping code. `latestStepStatus` reuses the same `pipelinePayload()` narrowing helper from Phase 1 rather than re-deriving the pipeline payload shape.

### Challenge: Stale Replica-Set Hostname After Container Recreation

Bringing the Mongo container back up for this phase's live verification hit `MongoServerError: node is not in primary or recovering state`. `docker-compose.yml` pins `container_name` for the Mongo service but not `hostname`, so Docker assigns a new internal hostname (the new container's short ID) on every recreation. The single-node replica set's config — persisted in the `mongo_data` volume, which survives `down` — still listed the previous container's hostname as its only member, and that hostname no longer resolved. The healthcheck's `try { rs.status() } catch(e) { rs.initiate() }` only calls `rs.initiate()` when `rs.status()` throws; here `rs.status()` succeeds (the replica set is configured, just unreachable), so the catch branch never runs. Fixed with `rs.reconfig(cfg, { force: true })` after updating `cfg.members[0].host` to the current hostname — preserves the seeded demo data instead of wiping the volume. This will recur on any future `down`/`up` cycle unless `hostname:` is pinned in the compose file; flagged to the user as a follow-up, not fixed as part of this GraphQL phase.

### Challenge: `Collection.prototype` Patching, Not Instance Patching, for Query-Counting

The before/after DataLoader demo needed to count actual Mongo `find()` invocations. Patching `.find` on one `db.collection(EVENTS_COLLECTION)` instance silently under-counted, because the MongoDB driver's `Db.collection()` returns a fresh `Collection` wrapper object on every call — the loader's own internal call obtains a different instance than the one the verification script patched. Patching `Collection.prototype.find` instead affects every instance via the prototype chain regardless of which call site obtained it, giving an accurate count: a naive per-field-instantiated loader made 5 Mongo queries for 5 pipeline runs; the per-request DataLoader made 1.
