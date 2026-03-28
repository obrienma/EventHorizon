# ADR 0006 — MongoDB as Append-Only Event Log

**Status:** Accepted

---

## Context

The storage plane must persist events durably so they can be queried and observed via change streams. A decision is needed about how documents are written and whether they can be updated after the initial insert.

The ingestion plane writes a raw event. The processing plane then enriches and classifies it. A naïve approach is to insert the raw event first, then update the document with the `processed` sub-document when the worker completes. An alternative is to write the complete document in a single operation when processing succeeds.

Additionally, the worker operates under at-least-once delivery (see ADR 0005). The same event may be delivered more than once. The storage layer must handle duplicate writes without corrupting the dataset.

## Decision

MongoDB `events` collection is **append-only**. No document is updated after insert. The worker writes a single complete document containing both the raw event and the `processed` sub-document in one `insertOne` call. A unique index on `{ "raw.id": 1 }` enforces deduplication. Duplicate key errors (MongoDB error code `11000`) are caught and silently discarded — not re-thrown.

## Rationale

**Append-only** aligns with event sourcing principles: the raw event is the source of truth. If classification logic changes in the future, every event can be reprocessed from `raw` without data loss.

**Single composite write** is simpler than a two-phase insert-then-update: there is no partial document state to reason about, no race condition between the insert and update, and no need to handle the case where an insert succeeded but the update was lost.

**Idempotent insert via unique index** is the correct mechanism for at-least-once delivery. Swallowing error code `11000` is not an oversight — it is an explicit design choice. Re-throwing duplicate key errors would cause the worker to retry, republish, and eventually dead-letter a message that was already successfully stored.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Insert raw → update with processed | Mirrors the two-step pipeline stages | Creates partial document state; update may be lost on crash; harder to guarantee idempotency |
| Upsert (`updateOne` with `upsert: true`) | Handles raw-then-processed in one call | More complex query; partial updates still possible; update-in-place violates append-only invariant |
| PostgreSQL with JSONB | Strong consistency guarantees; SQL queries | Relational model awkward for heterogeneous event shapes; change stream pattern requires triggers or polling |

## Consequences

- No `updateOne`, `replaceOne`, or `findOneAndUpdate` calls exist anywhere in the storage plane.
- The unique index `{ "raw.id": 1, unique: true }` must be created before the service accepts traffic (created in the `db.ts` initialisation function).
- Workers can safely retry failed inserts without risk of duplicate documents.
- If classification logic changes, a migration script processes the `raw` field of existing documents — the original data is never lost.
- Confidence: **High**. Standard event sourcing pattern.
