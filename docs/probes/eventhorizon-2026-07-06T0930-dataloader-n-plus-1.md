---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-23, graphql, dataloader, n+1]
---
Q: What's the actual mechanism by which a single per-request `DataLoader` turns N `.load(pipelineId)` calls into one Mongo query, instead of N?

A: DataLoader doesn't run its batch function immediately when `.load()` is called — it queues the key and schedules the batch function on the microtask queue (via `process.nextTick`/`Promise.resolve().then()`). Every `.load()` call made during the same GraphQL request, before that microtask fires, gets collected into one array of keys, and the batch function runs once with all of them — one `find({ pipelineId: { $in: [...] } })` regardless of N. This only works if all N runs' `steps` resolvers execute within the same tick using the *same* loader instance; a fresh loader per field call would batch nothing.

Extra: EventHorizon · Phase 23 · Pattern: DataLoader Batches Per-Request, Not Per-Field
See: docs/journal/eventhorizon-2026-07-06T0930-dataloader-n-plus-1.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-23, graphql, dataloader]
---
DataLoader's batch function must return an array {{c1::the same length and in the same order}} as the keys it was given — index *i* of the result answers index *i* of the request. `createPipelineStepsLoader()` groups matching documents into a `Map<pipelineId, StoredEvent[]>` first, then explicitly does `pipelineIds.map((id) => byPipelineId.get(id) ?? [])` rather than returning {{c2::the Map's values directly}}, because Map iteration order matching the request order isn't a guaranteed contract to rely on.

Extra: EventHorizon · Phase 23 · Anti-Pattern Avoided: Reordering the Batch Result
See: docs/journal/eventhorizon-2026-07-06T0930-dataloader-n-plus-1.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-23, mongodb, docker]
---
Q: Why did the Mongo container throw `node is not in primary or recovering state` after a `docker compose down` + `up`, and why didn't `rs.initiate()` in the healthcheck fix it automatically?

A: `docker-compose.yml` pins `container_name` for the Mongo service but not `hostname`, so Docker assigns a new internal hostname (the new container's short ID) on every recreation. The single-node replica set's config — persisted in the `mongo_data` volume, which survives `down` — still listed the *previous* container's hostname as its only member, and that hostname no longer resolves. The healthcheck's `try { rs.status() } catch(e) { rs.initiate() }` only calls `rs.initiate()` when `rs.status()` throws; here `rs.status()` succeeds (the replica set is configured, just unreachable), so the catch branch never runs. Fixed with `rs.reconfig(cfg, { force: true })` after updating `cfg.members[0].host` to the current hostname — preserves the data volume instead of wiping it. Recurs on every future `down`/`up` cycle unless `hostname:` is pinned in the compose file.

Extra: EventHorizon · Phase 23 · Challenge: Stale Replica-Set Hostname After Container Recreation
See: docs/journal/eventhorizon-2026-07-06T0930-dataloader-n-plus-1.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-23, mongodb, testing]
---
Q: A verification script tried to count Mongo `find()` calls by patching `.find` on `getDb().collection(EVENTS_COLLECTION)`, but the count came back lower than the real number of queries. Why, and what fixed it?

A: `Db.collection()` returns a fresh `Collection` wrapper object on every call rather than a cached singleton — so patching `.find` on one instance only counts calls made through that exact object. The loader's own code calls `getDb().collection(...)` separately and gets a different instance, so its `find()` calls went uncounted. Patching `Collection.prototype.find` instead affects every instance via the prototype chain, regardless of which call site obtained it — this is what gave an accurate count.

Extra: EventHorizon · Phase 23 · Challenge: Collection.prototype Patching, Not Instance Patching, for Query-Counting
See: docs/journal/eventhorizon-2026-07-06T0930-dataloader-n-plus-1.md
