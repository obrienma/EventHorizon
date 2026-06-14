---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-7, nodejs, event-loop]
---
`timer.unref()` marks a timer as a {{c1::background handle}} — it fires normally while other ref'd handles are active, but won't prevent the process from exiting when everything else has closed. `{{c2::timer.ref()}}` re-registers it as a handle that keeps the event loop alive.

Extra: EventHorizon · Phase 7 · Pattern: timer.unref() for Background Maintenance Timers
See: docs/journal.md#phase-7-event-loop-refcounting

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-7, nodejs, shutdown, anti-pattern]
---
The metrics interval and WebSocket heartbeat both call `.unref()` because they're {{c1::maintenance timers}} that shouldn't own the process lifecycle — without it they'd remain live handles after HTTP/MongoDB/AMQP shut down, and the event loop would spin indefinitely. This avoided anti-pattern is named {{c2::Timers That Own the Process Lifecycle}}.

Extra: EventHorizon · Phase 7 · Pattern: timer.unref() for Background Maintenance Timers
See: docs/journal.md#phase-7-event-loop-refcounting
