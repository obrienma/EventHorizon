---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-9, mongodb, change-streams]
---
MongoDB change streams expose a `{{c1::resume token}}` (`_id` field) on every delivered event, encoding the cursor's position in the replica set oplog. Reopening a stream with `{{c2::resumeAfter: lastToken}}` replays events that occurred while the cursor was dead — zero-gap delivery.

Extra: EventHorizon · Phase 9 · Pattern: Change Stream Resume with Resume Token
See: docs/journal/eventhorizon-2026-04-01T0900-resume-token-recovery.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-9, mongodb, change-streams]
---
`countDocuments` survives a MongoDB restart because it creates a {{c1::fresh connection and query}} on each call — the driver reconnects transparently. A change stream is a {{c2::long-lived cursor}} pinned to an oplog position; once invalidated, it must be explicitly reopened — there is no automatic reconnection for cursors.

Extra: EventHorizon · Phase 9 · Pattern: Change Stream Resume with Resume Token
See: docs/journal/eventhorizon-2026-04-01T0900-resume-token-recovery.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-9, monitoring, anti-pattern]
---
If `stream.on("error")` only logs without restarting, the cursor dies but the server keeps running — stats still broadcast via {{c1::countDocuments}} queries on a 5s interval, so the dashboard connection dot stays green while the {{c2::event feed}} silently freezes. This is a class of {{c3::partial failure}} that monitoring must be designed to detect explicitly.

Extra: EventHorizon · Phase 9 · Anti-Pattern Avoided: Silent Cursor Death
See: docs/journal/eventhorizon-2026-04-01T0900-resume-token-recovery.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-9, concurrency, shutdown]
---
To avoid a race between a pending retry timer and shutdown, teardown must, in order: set `{{c1::shuttingDown = true}}` first, then `{{c2::clearTimeout(retryTimer)}}`, then close the stream. Reversing the first two steps lets the error handler schedule a new timer in the gap between `clearTimeout` and the stream close.

Extra: EventHorizon · Phase 9 · Challenge: Exponential Backoff + Shutdown Race
See: docs/journal/eventhorizon-2026-04-01T0900-resume-token-recovery.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-9, tradeoff, durability]
---
Q: Why does Phase 9 store the change stream resume token only in memory rather than persisting it to disk, and what's the accepted trade-off?

A: Persisting to disk (file, Redis, etc.) would let a full server restart resume from the exact pre-restart oplog position with zero gaps, but it adds file I/O, a startup read path, and failure modes around stale or corrupt token files. The accepted trade-off is that a server restart replays nothing — the new stream starts from the current oplog head. This is acceptable because the observation plane is best-effort; missing events during a restart doesn't lose data (it's already durably stored by the worker). Phase 11 revisits this decision and persists the token.

Extra: EventHorizon · Phase 9 · Decision: In-Memory Resume Token (Not Persisted)
See: docs/journal/eventhorizon-2026-04-01T0900-resume-token-recovery.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-9, delivery-guarantees, tradeoff]
---
Q: Why is the resume token updated *before* calling `onInsert` (the broadcast), and what delivery guarantee does that create for the observation plane?

A: Updating the token first means that if the server crashes between the two lines, the token has already advanced past that event — on restart, `resumeAfter: lastToken` skips it and it's never broadcast. This makes the observation plane's delivery guarantee at-most-once. It's acceptable because the observation plane is a live-view overlay, not the source of truth — the event is already durably stored in MongoDB by the worker. The alternative (token after `onInsert`, at-least-once) would replay and re-broadcast the event on restart, but the dashboard has no deduplication, so the client would render it twice. For a live feed, a silent gap is better UX than a visible duplicate — delivery guarantees should match the plane's contract, not be applied uniformly.

Extra: EventHorizon · Phase 9 · Decision: Resume Token Updated Before Broadcast — At-Most-Once Observation Delivery
See: docs/journal/eventhorizon-2026-04-01T0900-resume-token-recovery.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-9, mongodb, change-streams]
---
MongoDB change streams work by tailing the `{{c1::oplog}}` — a rolling write-ahead log maintained for replication. This is fundamentally different from polling: polling repeatedly issues fresh `{{c2::find / countDocuments}}` queries, while a change stream holds a `{{c3::long-lived cursor}}` that MongoDB pushes new events into. No wasted round-trips; sub-millisecond delivery after each insert.

Extra: EventHorizon · Phase 9 · Pattern: Change Stream as Oplog Tail (vs. Polling)
See: docs/journal/eventhorizon-2026-04-01T0900-resume-token-recovery.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-9, mongodb, change-streams, testing]
---
Q: Change streams require a replica set and don't work on a standalone mongod. How does EventHorizon satisfy this in local dev, and what does it mean for the test suite?

A: docker-compose.yml starts MongoDB with `--replSet rs0` and runs `rs.initiate()` on first boot to create a single-node replica set — enough for the oplog to exist and `.watch()` to work. In tests, `mongodb-memory-server` would need explicit replica set mode, which adds ~1–2s to startup per suite. The trade-off was accepted by not automating change stream tests at all — they're verified manually. This is the only automated-test gap in the project driven purely by infrastructure cost rather than code complexity.

Extra: EventHorizon · Phase 9 · Challenge: Change Streams Require a Replica Set
See: docs/journal/eventhorizon-2026-04-01T0900-resume-token-recovery.md
