---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-22, graphql, typescript]
---
Q: The Zod schema and MongoDB documents store event types as lowercase strings (`"pipeline"`, `"processed"`, `"normal"`), but the GraphQL schema declares uppercase enum names (`PIPELINE`, `PROCESSED`, `NORMAL`). How does `resolvers.ts` bridge that without manual case-conversion code?

A: GraphQL enum value maps. Exporting `EventType: { PIPELINE: "pipeline", SENSOR: "sensor", APP: "app" }` (and the equivalent for `EventStatus`/`Classification`) tells Apollo the internal value behind each external enum name. Query args arrive already converted to the internal lowercase string, and returning that same internal string from a field resolver serializes back to the correct uppercase name — no `.toUpperCase()`/`.toLowerCase()` anywhere in resolver code.

Extra: EventHorizon · Phase 22 · Pattern: GraphQL Enum Value Maps Instead of Manual Case Conversion
See: docs/journal.md#phase-22-graphql-query-api-phase-1-real-schemaresolvers

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-22, graphql, typescript]
---
`Event.__resolveType` tells GraphQL which concrete resolver map to call for a given document, but it does {{c1::not narrow TypeScript's view of `doc.raw`}} inside that map — the parent object stays typed as the full `StoredEvent` union. The `pipelinePayload()`/`sensorPayload()`/`appPayload()` helpers narrow explicitly and {{c2::throw if the discriminant doesn't match}}, which is unreachable in correct operation but keeps the accessors total rather than silently wrong.

Extra: EventHorizon · Phase 22 · Anti-Pattern Avoided: Type Narrowing Silently Assumed Correct
See: docs/journal.md#phase-22-graphql-query-api-phase-1-real-schemaresolvers

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-22, adr, process]
---
Q: While implementing Phase 1, a gap turned up between ADR 0019's schema (which defines a `ProcessedMeta` type but never attaches it as a field anywhere) and the plan's own instructions (which say field resolvers should read `processed.*`). What was done about it, and why not just pick a placement and move on?

A: The inconsistency was surfaced to the user before writing any resolver code, rather than silently guessing where `processed` should attach. The resolved design — a nullable `processed: ProcessedMeta` field on the `Event` interface and all three concrete types, null when `status: FAILED` — was confirmed first, then ADR 0019 was amended in place (still `Proposed`, so no formal revision note needed). An ADR is supposed to be the source of truth for what was decided; quietly inventing a schema field to paper over its own internal contradiction would undermine that.

Extra: EventHorizon · Phase 22 · Decision: Add processed: ProcessedMeta to the Event Interface Before Writing Resolvers
See: docs/journal.md#phase-22-graphql-query-api-phase-1-real-schemaresolvers

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-22, wsl, environment]
---
Q: Live-verifying the Phase 1 resolvers by running `server.ts` and `worker.ts` simultaneously caused both dev processes to hang silently well past their normal ~2s boot time. What was actually happening, and what verification approach was used instead?

A: WSL2 memory pressure — `free -h` showed 6.4/7.6GB used with swap fully exhausted, so both processes were swap-thrashing rather than genuinely stuck. Both were killed before they triggered the OOM crash this project's memory notes already flag as a known WSL2 risk. The re-verification used a single lightweight script instead: `app.inject()` against the already-running Fastify `app` (no live `.listen()`), with `StoredEvent`s written directly via `saveEvent`/`saveFailedEvent` — bypassing RabbitMQ and the worker process entirely, since the thing under test was the GraphQL resolvers, not the ingestion pipeline.

Extra: EventHorizon · Phase 22 · Challenge: Verification Under WSL2 Memory Pressure
See: docs/journal.md#phase-22-graphql-query-api-phase-1-real-schemaresolvers
