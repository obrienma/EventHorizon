---
id: eventhorizon-2026-04-01T0900-resume-token-recovery
repo: eventhorizon
title: "Change Stream Resume Token Recovery"
date: 2026-04-01
phase: 9
tags: [mongodb, change-streams, resume-token, exponential-backoff, silent-cursor-death, partial-failure]
files: [src/observation/changeStream.ts]
---

### Pattern: Change Stream Resume with Resume Token

MongoDB change streams expose a `_id` field — the resume token — on every delivered event, encoding the cursor's exact position in the replica set oplog. Reopening a stream with `{ resumeAfter: lastToken }` replays any events that occurred while the cursor was dead, giving zero-gap delivery. Without recovery, a cursor failure (MongoDB restart, network blip, replica set election) silently kills the observation plane; the metrics interval still works, since it issues fresh `countDocuments` queries on each tick, so the dashboard appears healthy — stats update, the connection dot is green — but the event feed freezes, and thousands of events can process invisibly while a developer thinks the dashboard is broken for some other reason. The fix in `changeStream.ts`: store `resumeToken` in a closure variable, updated on every `change` event; on `error`, schedule `open()` with exponential backoff, passing `{ resumeAfter: resumeToken }`; on teardown, set `shuttingDown = true` and cancel any pending retry timer before closing the stream. `countDocuments` survives a restart because it creates a fresh connection and query on each call, and the driver handles reconnection transparently; a change stream is a long-lived cursor pinned to an oplog position, and when the cursor is invalidated it must be explicitly reopened — there is no automatic reconnection for cursors.

### Anti-Pattern Avoided: Silent Cursor Death

If `stream.on("error")` only logs the error without restarting, the cursor is dead but the server keeps running. Stats still broadcast every 5s via regular queries, so the dashboard connection dot stays green while the event feed is frozen — no alarm, no crash, just one logged error that scrolls off the screen. This is deceptive because the observation plane has two sub-paths, cursor-based (change stream → event broadcast) and query-based (`countDocuments` → stats broadcast); a failure in one doesn't affect the other, so from outside the server only the healthy sub-path is visible. This is a class of partial failure that monitoring must be designed to detect explicitly.

### Decision: In-Memory Resume Token (Not Persisted)

The resume token is stored only in memory, not on disk. Persisting to disk (file, Redis, etc.) would let a full server restart resume from the exact pre-restart position with no events missed across restarts, but it adds file I/O, a startup read path, and failure modes around stale or corrupt token files. The trade-off accepted: a server restart replays nothing, and the new stream starts from the current oplog head. For this pipeline the observation plane is best-effort, so missing events during a restart is acceptable — in a production system with strict delivery guarantees, the token would be persisted. Phase 11 revisits this decision and persists the token.

### Challenge: Exponential Backoff + Shutdown Race

When the cursor errors, `open()` is scheduled via `setTimeout`. If the server shuts down during that delay window, the timer fires after MongoDB has already closed, and `open()` calls `getDb()` on a dead connection and throws. The fix tracks the timer reference (`retryTimer`); in the teardown function, `shuttingDown = true` is set first (preventing new timers from being scheduled in the error handler), then `clearTimeout(retryTimer)` is called if pending, then the stream is closed. Order matters: setting `shuttingDown` before `clearTimeout` prevents a race where the error handler fires between the `clearTimeout` call and the stream close, scheduling a new timer.

### Decision: Resume Token Updated Before Broadcast — At-Most-Once Observation Delivery

The resume token is updated before calling `onInsert` (the broadcast). If the server crashes between those two lines, the observation plane's delivery guarantee for that event is at-most-once: the token has already advanced past the event, so `resumeAfter: lastToken` on restart skips it, and that event is never broadcast. This is acceptable because the observation plane is a live-view overlay, not the source of truth — the event is already durably stored in MongoDB, written by the worker, ack'd, append-only. A missed broadcast means one event doesn't appear in the feed for that window; no data is lost. Flipping the order (token after `onInsert`, at-least-once) would replay and re-broadcast the event on restart, but the dashboard has no deduplication, so the client would render it twice — for a live event stream, a silent gap is better UX than a visible duplicate. The deeper principle: delivery guarantees should match the plane's contract. The storage plane promises at-least-once (RabbitMQ ack-after-write plus idempotent insert absorbs replays); the observation plane promises best-effort push to currently-connected clients. Applying at-least-once to a layer where duplicates are visible and unhandled is the wrong guarantee for the wrong layer.
