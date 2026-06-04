# ADR 0013 — Durable Resume Token Checkpoint

**Status:** Accepted

---

## Context

ADR-0011 implemented change stream recovery using a resume token held in a closure variable — in-memory only. The stated rationale was that a server restart is an operator action, not a transient fault, and restarting from the current oplog head was acceptable. Persistence was deferred as a future production concern.

The k3s deployment work (Phase 14) changes the operating assumption. In a Kubernetes-managed environment, pod restarts are routine and involuntary — OOM kills, node evictions, rolling deploys, and liveness probe failures all restart the container without operator involvement. With in-memory-only storage, every such restart silently re-anchors the change stream at the current oplog head. Events inserted during the outage are never delivered to WebSocket clients. The dashboard's live feed and the stored event count in MongoDB diverge with no observable signal.

The in-memory assumption that "a restart is intentional" is no longer valid at k3s scale.

## Decision

Persist the change stream resume token to a dedicated MongoDB collection (`changestream_checkpoints`, single document keyed `"observation"`) via `src/observation/checkpoint.ts`. On startup, `startChangeStream()` loads the saved token (making the function async). On each delivered event, the token is written via `saveResumeToken()` — fire-and-forget, not awaited. On oplog overrun (MongoDB error 286, `ChangeStreamHistoryLost`), the stale checkpoint is cleared and the stream restarts from the current oplog head.

## Rationale

**Why MongoDB instead of Redis:**
ADR-0011 listed "persisted to MongoDB" as rejected due to circular dependency (need Mongo to load the token to reconnect to Mongo). On closer analysis, this concern is self-resolving: if MongoDB is unreachable, the change stream cannot open regardless of whether a token is available. The token is only needed when MongoDB is reachable — at which point reading it is trivially possible. No new infrastructure dependency is required.

**Why fire-and-forget checkpoint writes:**
Awaiting `saveResumeToken()` in the change event handler adds a MongoDB round-trip to every event delivery. A failed write is logged but does not interrupt delivery. The worst case is mild: on the next pod restart, the loaded token is slightly behind the last delivered event, causing a few events to be replayed. The idempotent insert in `event.repository.ts` (unique index on `raw.id`, error 11000 swallowed) absorbs replays without side effects. Delivery guarantee: at-least-once.

**Why handle oplog overrun explicitly:**
Without detection, a stale token from a long-ago pod restart causes `startChangeStream()` to enter an infinite retry loop — each attempt fails with error 286, backoff grows to 30s, and the observation plane is permanently broken until the process is manually restarted. Detecting error code 286, clearing the checkpoint, and restarting from the current oplog head converts a permanent hang into a bounded gap: the outage window's events are missed, but the stream recovers and resumes normal operation immediately.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| In-memory only (ADR-0011) | No I/O, simple | Lost on every pod restart; silent event gap |
| Persist to MongoDB (this ADR) | No new infra; consistent with storage plane | Circular dep concern (resolved above); fire-and-forget write means token can lag |
| Persist to Redis | No circular dep; fast | New infrastructure dependency; adds operational surface |
| Persist to local file | No network dep | Requires PersistentVolume in k3s; volume provisioning overhead for a single small value |
| Write-ahead checkpoint | Exactly-once token durability | Synchronous write per event; adds latency to delivery hot path |

## Consequences

- Pod restarts now replay missed events from the oplog rather than silently dropping them.
- `startChangeStream()` signature changed from synchronous (`() => Promise<void>`) to async (`Promise<() => Promise<void>>`). Call site in `server.ts` updated to `await`.
- A new failure mode is introduced: oplog overrun. Handled explicitly — stale token is detected, cleared, and the stream restarts cleanly from the current oplog head. Events during the gap are not replayed (known and accepted).
- Checkpoint writes add one `updateOne` per delivered event to the `changestream_checkpoints` collection. At low-to-medium event rates this is negligible. At high rates, debouncing the write (e.g. every N events or every N ms) is the next optimisation.
- ADR-0011 is superseded. Its cursor recovery and backoff logic is unchanged; only the token storage scope changes.
