---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-3, mongodb, idempotent-receiver]
---
`saveEvent()` only swallows MongoDB error code `{{c1::11000}}` (duplicate key) — the signature of the {{c2::Idempotent Receiver}} absorbing an expected at-least-once replay. All other `MongoServerError` types re-throw, because swallowing them would ack a message that was never actually persisted.

Extra: EventHorizon · Phase 3 · Pattern: Idempotent Receiver
See: docs/journal.md#phase-3-storage-plane

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-3, startup-order, delivery-guarantees]
---
Q: Why must the EventHorizon worker connect to MongoDB before connecting to RabbitMQ at startup?

A: If RabbitMQ connected first, the worker would start consuming and acking messages before knowing whether it can persist them — a MongoDB outage would cause acked messages to be silently dropped. Connecting MongoDB first means a failed startup leaves messages safely in the broker queue, preserving at-least-once delivery; AMQP consumption never begins until persistence is confirmed possible.

Extra: EventHorizon · Phase 3 · Pattern: Fail-Fast Startup
See: docs/journal.md#phase-3-storage-plane

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-3, error-handling, anti-pattern]
---
In the dead-letter path, `saveFailedEvent(event)` is wrapped in `{{c1::.catch()}}` rather than a try/catch around both it and `ch.nack()`. If the save throws uncaught, `ch.nack()` never runs and the message stays unacknowledged — {{c2::head-of-line blocking}} in the prefetch window. The MongoDB failure record is best-effort; the routing to {{c3::events.dead}} must be unconditional.

Extra: EventHorizon · Phase 3 · Anti-Pattern Avoided: Blocking the Nack with a Best-Effort Write
See: docs/journal.md#phase-3-storage-plane

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-3, delivery-guarantees, mongodb]
---
Q: Why must `saveEvent()` be called before `ch.ack()`, and what happens if the order is flipped?

A: `ack` tells the broker to permanently delete the message. If you ack first and the write then fails, the message is gone — no retry, no dead-letter, permanently lost. Saving first means a failed write leaves the message unacknowledged so the catch block can retry or dead-letter it. If `saveEvent` succeeds but the ack itself is lost, the broker redelivers — the Idempotent Receiver (unique index on `raw.id`) makes the second insert a silent no-op, so save-before-ack is safe even under redelivery.

Extra: EventHorizon · Phase 3 · Pattern: Save Before Ack (Write-Then-Acknowledge)
See: docs/journal.md#phase-3-storage-plane

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-3, typescript, anti-pattern]
---
Declaring `const event = EventSchema.parse(raw)` inside a `try` block makes `event` unreachable in `catch`. The fix hoists `{{c1::let event: AppEvent | undefined}}` before the try, then guards the dead-letter call with `{{c2::if (event !== undefined)}}` — also correctly handling the case where parsing itself failed and there's nothing to save.

Extra: EventHorizon · Phase 3 · Anti-Pattern Avoided: Variable Scope Trap (try/catch)
See: docs/journal.md#phase-3-storage-plane

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-3, pipeline, state-machine]
---
Save-before-ack corresponds to the `{{c1::Processing → Processed}}` transition in the event-lifecycle state machine — `ch.ack()` is only called once `enrich`+`classify`+`insertOne` have all succeeded.

Extra: EventHorizon · Phase 3 · Pattern: Save Before Ack (Write-Then-Acknowledge)
See: docs/journal.md#phase-3-storage-plane
