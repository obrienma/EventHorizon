# ADR 0011 — Change Stream Resume Token Recovery

**Status:** Accepted

---

## Context

ADR 0008 established the MongoDB change stream as the mechanism for pushing new events to WebSocket clients. It noted resume token support as a future extension and left the error handler as a log-only stub.

In practice, the stub produced a deceptive failure mode: when the change stream cursor died (MongoDB container restart, replica set election, network blip), the server continued running and the dashboard appeared healthy — stats updated on schedule, the WebSocket connection dot stayed green — but the event feed silently froze. The cursor was dead and nothing restarted it.

This failure was diagnosed when `totalProcessed` showed 19,661 processed events in the stats bar while zero events appeared in the live feed. The observation plane had two independent sub-paths (cursor-based event push, query-based stats push), and only the cursor-based path had failed. From the outside, only the healthy sub-path was visible.

## Decision

Implement **cursor invalidation recovery with in-memory resume token** in `observation/changeStream.ts`.

On every delivered change event, store `change._id` (the resume token) in a closure variable. On cursor error, reopen the stream with `{ resumeAfter: lastResumeToken }` after an exponential backoff delay. MongoDB replays any inserts that occurred between the cursor failure and the reconnect — zero event gap for transient failures.

The resume token is held in memory only. It is not persisted to disk or an external store.

## Rationale

**Why resume tokens, not a blind restart:**
A blind restart (reopen without `resumeAfter`) creates a stream anchored at the current oplog head. Any events inserted during the outage are permanently missed. This violates the pipeline's implicit delivery contract and produces invisible data loss — the event count in MongoDB diverges from the count delivered to WebSocket clients, with no observable signal.

Resume tokens are MongoDB's first-class mechanism for this. Every change event already carries one at no extra cost. Using it converts a blind restart into a replay-from-checkpoint restart.

**Why in-memory token (not persisted):**
Persisting the token to disk would allow recovery across a full server restart. That adds a file I/O path, a startup read with deserialization, and failure modes around stale or corrupt token files. The observation plane is best-effort by design — a server restart is an operator action, not a transient fault, and restarting the stream from the current oplog head is acceptable. In a production system with strict delivery SLAs, the token would be persisted (Redis, a dedicated collection, or a local file).

**Why exponential backoff:**
A tight retry loop against an unavailable MongoDB generates log noise and wastes CPU without improving recovery time. Backoff starts at 1s and doubles per attempt, capped at 30s. A successful event delivery resets the backoff, so a brief blip (1s outage) does not permanently slow subsequent recovery.

**Why reset backoff on success, not on reconnect:**
The stream can reopen and receive zero events if the collection is quiet. Resetting on stream open would give false confidence — the connection might drop again immediately. Resetting on the first delivered event confirms the cursor is healthy end-to-end.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Log-only error handler (original) | Zero code | Cursor dies silently; deceptive healthy appearance |
| Blind restart (no resume token) | Simple | Misses all events inserted during outage; invisible data loss |
| Resume token, persisted to disk | Survives server restart | File I/O path; stale/corrupt token failure modes; over-engineered for this pipeline |
| Resume token, persisted to MongoDB | Durable across restarts + container moves | Circular dependency: if Mongo is down, we can't save the token we need to reconnect to Mongo |
| Fixed retry delay | Simpler than backoff | Log spam and CPU waste during extended outages |

## Consequences

- Transient cursor failures (MongoDB restart, RS election, network blip) are now recovered automatically. Events inserted during the outage are replayed from the oplog via the resume token.
- A full server restart still misses events inserted while the server was down (the in-memory token is lost). This is a known and accepted trade-off.
- If the server is down long enough for the oplog to roll past the resume token (oplog overrun), MongoDB rejects the token and the retry loop stalls at `RETRY_MAX_MS`. This is not yet handled. The fix is to inspect the error code (`286` / `ChangeStreamHistoryLost`) and fall back to a tokenless restart.
- The shutdown sequence must cancel any pending retry timer before closing MongoDB, otherwise the timer fires against a closed connection. `shuttingDown = true` is set before `clearTimeout` to close the scheduling race window.
- ADR 0008's note "A `resumeToken` can be stored... This is not yet implemented" is now resolved.
- Confidence: **High**. Resume tokens are the canonical MongoDB recovery mechanism. The in-memory-only scope is a deliberate simplification, not a workaround.
