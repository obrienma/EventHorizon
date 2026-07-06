---
title: "GraphQL Over Four Planes: An ADR That Contradicted Itself, and the N+1 We Measured Instead of Assumed"
date: 2026-07-06
tags: [event-horizon, graphql, dataloader, distributed-systems, architecture-decision-records]
summary: EventHorizon's dashboard has always been a live feed with no way to query history. Adding a read-only GraphQL layer over the Storage plane surfaced a self-contradicting ADR before a line of resolver code was written, and gave the DataLoader N+1 story an actual measurement instead of a "trust me, it's the reference implementation."
draft: true
---

Every post in this series so far has been about the write path or the push path: validate an event, queue it, persist it, broadcast it. Four planes, one direction, no way back. That's been true since Phase 1, and it stayed true through OpenTelemetry, through Kubernetes manifests, through the WebSocket backpressure fix in the previous phase. What none of it gave you was a way to *ask a question*. "Show me the last 20 failed sensor events." "What happened during pipeline run `pipe-47`?" There was no answer to either, short of opening a Mongo shell.

This post is about closing that gap with a read-only GraphQL API — and about two things that happened along the way that were more interesting than the feature itself: an architecture decision record that quietly contradicted its own implementation plan, and an N+1 query problem that got measured instead of assumed away.

---

## Does a query API break "one direction"?

The first question worth asking before writing any schema was whether this violates the project's one hard rule about data flow: Ingestion → Processing → Storage → Observation, one direction, nothing flows backwards. A GraphQL API sitting on top of MongoDB *reads* the Storage plane's data. Is that a fifth stage bolted onto the pipeline, or something else?

It's something else, and the reasoning is worth spelling out because it generalizes: a read API isn't a stage in a pipeline at all. A pipeline stage sits between two other stages and passes transformed data forward. This sits *beside* the pipeline, pulling from data already at rest, the same relationship the Observation plane's metrics poller already has with MongoDB — `metrics.ts` has been querying `countDocuments` and running aggregations against the `events` collection since Phase 5. Nobody argued that violated the one-direction invariant, because polling for stats isn't a pipeline stage either. GraphQL is the same shape of thing with a friendlier query language on top.

This distinction — *orthogonal to the pipeline* versus *a stage in the pipeline* — is the kind of thing worth naming explicitly in an ADR rather than leaving implicit, because "does this violate our hard invariant" is exactly the question a future reader will ask first, and an ADR that doesn't answer it up front makes them re-derive the answer themselves.

---

## The enum casing trick

One small mechanical detail turned out to be more satisfying than expected: internally, everything is lowercase. The Zod schema says `type: z.literal("pipeline")`. MongoDB documents store `status: "processed"`. GraphQL's SDL convention says enums are `SCREAMING_SNAKE_CASE`: `PIPELINE`, `PROCESSED`, `NORMAL`. The naive approach is writing translation code — uppercase on the way out, lowercase on the way in, scattered across every resolver that touches a typed field.

Apollo (and graphql-js underneath it) has a better answer: enum *value maps*. You tell the resolver map what the external enum name corresponds to internally —

```ts
EventType: { PIPELINE: "pipeline", SENSOR: "sensor", APP: "app" }
```

— and after that, the conversion is invisible. A resolver returning `doc.status` (which is literally the string `"processed"`) gets serialized to the client as `PROCESSED` automatically. A query argument `events(status: PROCESSED)` arrives inside the resolver as the string `"processed"`, ready to filter a Mongo query with. Zero `.toUpperCase()` calls anywhere in `resolvers.ts`. It's a small thing, but it's the difference between "the schema and the storage layer are two systems glued together with string surgery" and "the schema is a typed view over data that was already well-modeled."

---

## The ADR that contradicted itself

Here's the part I didn't expect. The ADR's schema block defined a `ProcessedMeta` GraphQL type — `receivedAt`, `enrichedAt`, `classification`, `tags` — mirroring the `processed` sub-document that the worker writes once per successful event. Sensible enough. But nowhere in the schema did any type actually have a `processed: ProcessedMeta` field. Not on `Event`, not on `PipelineEvent`, not anywhere. It was a fully-formed type with nothing pointing at it — invisible to any query, dead on arrival.

Meanwhile, the companion implementation plan's Phase 1 instructions said, plainly: "Field resolvers on each concrete type read from `raw.payload.*` *and* `processed.*` on the stored document." The plan assumed a field that the schema it was implementing didn't have.

Two documents, written together, disagreeing with each other about a fact that should have been unambiguous. This is exactly the kind of thing that's easy to paper over in the moment — just add the field somewhere reasonable-looking and move on, nobody will notice a resolver returning a value for a field that "obviously" should exist. But an ADR is supposed to be the source of truth for *what was decided*, and quietly picking a placement to make the inconsistency go away would mean the record no longer matches the decision — it would just be the artifact of whichever placement felt convenient when the gap was noticed.

So instead of guessing, I stopped and asked: where should `processed` actually live? The answer that came back was the interface level — a nullable `processed: ProcessedMeta` on `Event` itself (and therefore on all three concrete types), `null` for `FAILED` events, since a `StoredEvent` with `status: "failed"` never gets a `processed` sub-document written at all. That's a real modeling fact about the domain, not an arbitrary choice: the schema's nullability now says something true about when the data exists, rather than the field just being present because it seemed likely someone would want it.

The ADR got amended in place before any resolver code was written — it was still `Proposed` at that point, so there was no need for a formal revision note, just a corrected schema block. The lesson generalizes past this one gap: when a design document contradicts its own implementation plan, that's worth surfacing and resolving explicitly, not silently reconciling in whichever direction is locally convenient.

---

## The real N+1, measured instead of assumed

The schema has a `pipelineRuns` query that returns every distinct pipeline ID, and each run has a `steps` field — every `PipelineEvent` belonging to that pipeline. Resolved the naive way, one `find({ pipelineId: id })` per run, this is the textbook N+1: N pipeline runs in a single request means N separate round trips to Mongo, when one `find({ pipelineId: { $in: [...] } })` would answer all of them at once.

DataLoader is the standard fix, and I could have written "we used DataLoader, it batches by design, N+1 solved" and left it there — that's the sentence you'll find in most GraphQL blog posts, treated as self-evidently true because it's the reference implementation. I wanted a number instead of a sentence.

The mechanism, briefly: DataLoader doesn't run its batch function the instant you call `.load(id)`. It queues the key and schedules the batch function on the microtask queue. Every `.load()` call made during the same tick — which, for a GraphQL request, means every `steps` field resolver across every `PipelineRun` in that one query — gets collected into a single array of keys before the batch function ever runs. One function call, one `$in` query, however many runs asked for their steps. The two things that make this actually work, and that are easy to get subtly wrong:

**One loader instance per request, not one global instance.** Apollo's context function creates a fresh `DataLoader` for every incoming request. A shared instance would cache one request's results and hand them back — stale — to the next unrelated request. This is a one-line difference in the plugin wiring, and it's the kind of bug that wouldn't show up in a demo with one client hitting the API sequentially — only under real concurrent load.

**The batch function's output has to match the input's order exactly** — index *i* of the result answers index *i* of the request. It's tempting to group results into a `Map` and return `Array.from(map.values())`, but Map iteration order matching request order isn't a contract, it's a coincidence that happens to hold for small inputs during testing. The correct version explicitly maps back over the original key array: `pipelineIds.map(id => byPipelineId.get(id) ?? [])`. Silent, wrong pairing between a step and the wrong pipeline run is a worse failure mode than a slow query, because it produces a plausible-looking wrong answer instead of an obvious error.

To actually measure the fix, I wrote a small script that ran both versions against the same seeded data: a naive version that instantiated a fresh loader per field call (defeating batching on purpose), and the real per-request version. Counting "how many times did Mongo's `find` actually run" needed one more small correction — my first attempt patched `.find` on a single `collection()` instance and got a suspiciously low count. Turns out MongoDB's driver hands back a *new* `Collection` wrapper object every time you call `db.collection(name)` — it's not a cached singleton — so patching one instance only counts calls made through that exact object reference. Patching `Collection.prototype.find` instead catches every call site regardless of which particular wrapper object made it.

With that fixed, the numbers were exactly what the theory predicted, which is a nicer feeling than it probably should be:

```
Found 100 distinct pipelineIds in the DB.
[naive/per-field]  5 pipeline runs -> 5 Mongo queries (N+1 reproduced)
[DataLoader]       5 pipeline runs -> 1 Mongo queries (batched via $in)
```

Five runs, five queries, versus five runs, one query. That's the sentence I wanted instead of "DataLoader solves N+1" — not because the standard claim is wrong, but because a measured number is worth more than a cited fact, especially when the measurement is nearly free to take.

---

## An unrelated infra detour, and the ADR closeout

While verifying all this against a real Mongo instance, I hit `MongoServerError: node is not in primary or recovering state` — nothing to do with GraphQL at all. The compose file pins the container's *name* but not its *hostname*, so a fresh container after `docker compose down` gets a new internal hostname, while the single-node replica set's configuration — persisted in the data volume, which survives `down` — still points at the old one. The healthcheck's `rs.initiate()` never fires to fix this, because `rs.status()` succeeds (the replica set is configured, just unreachable); only a genuinely uninitiated replica set trips that fallback. `rs.reconfig()` with the corrected hostname fixed it without losing the seeded demo data, but it'll happen again on the next `down`/`up` cycle until the compose file pins a stable hostname. Recorded as a known follow-up, not fixed as part of this work — it's unrelated to the decision the ADR is actually about, and folding it in would blur what the ADR is for.

Which is the last thing worth naming: closing out ADR 0019 meant more than flipping `Proposed` to `Accepted`. The document had made two checkable claims — Medium confidence on the Apollo/Fastify integration, and an implicit bet that DataLoader would actually fix the N+1 case — and both got a real answer instead of staying assumptions. The integration turned out fine across all three implementation phases (upgraded to High confidence). The N+1 fix is a number now, not a citation. An ADR that only ever records intentions and never comes back to check them against what happened is a weaker kind of record than one that does — and coming back to check is cheap, if you did the measuring already.

---

## Where to find it, and how it's versioned

The schema, entry points, and two worked example queries — including the `pipelineRuns` one, with a note on the DataLoader batching behind it — are documented in `docs/API.md` alongside the existing REST and WebSocket routes. The request-flow and schema diagrams (`Event` as an interface, the three concrete types, `PipelineRun`'s DataLoader-batched `steps`) are in `docs/diagrams/OVERVIEW.md`.

One question worth answering explicitly while writing that up: is this versioned the way the REST routes are supposed to be — `/v1/`, `/v2/`? No, and that's a deliberate GraphQL convention, not an oversight. REST versions the *endpoint* because the server decides the entire response shape, so any shape change can break every client hitting that URI. GraphQL clients declare exactly which fields they want back, which means adding a new field or type is non-breaking by construction — a query that never asked for that field is unaffected by its existence. So the schema evolves in place, at the one `/graphql` endpoint: new fields and types get added freely, a field that needs to go away gets `@deprecated(reason: "...")` first — visible through introspection, giving clients a migration window — and only gets removed once usage monitoring shows nothing queries it anymore. The genuinely breaking moves (renaming a field, changing its type, removing a required argument) get that same deprecation treatment; they never happen abruptly. No new endpoint, no new version number, just a schema that only ever grows and occasionally, carefully, sheds something nobody's using.
