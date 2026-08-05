---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-10, amqplib, flow-control]
---
`amqplib`'s `Channel.publish()` is synchronous and returns a `{{c1::boolean}}` — `{{c2::true}}` if the message was buffered, `{{c3::false}}` if the broker's write buffer was full ({{c4::flow control / backpressure}}). In `worker.ts`, this return value was discarded and `ch.ack(msg)` ran unconditionally on the next line.

Extra: EventHorizon · Phase 10 · Challenge: ch.publish() Silent Drop
See: docs/journal/eventhorizon-2026-05-14T0900-silent-message-drop.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-10, testing, mocking]
---
The bug was invisible to tests because `mockCh.publish` was declared as `{{c1::vi.fn()}}`, which returns `{{c2::undefined}}` by default — falsy, identical to a `false` return from the real method. The mock had {{c3::false fidelity}}: it appeared to match the real API but silently described the broken behaviour, and existing tests passed while modeling the buggy path.

Extra: EventHorizon · Phase 10 · Challenge: Mock Fidelity Masked the Bug
See: docs/journal/eventhorizon-2026-05-14T0900-silent-message-drop.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-10, amqplib, retry]
---
The fix: capture `publish()`'s return value and only `ch.ack(msg)` if `{{c1::published === true}}`. If `false`, emit a warning and leave the message {{c2::unacked}} — RabbitMQ redelivers it once the consumer is ready.

Extra: EventHorizon · Phase 10 · Challenge: ch.publish() Silent Drop
See: docs/journal/eventhorizon-2026-05-14T0900-silent-message-drop.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-10, delivery-guarantees, rabbitmq]
---
Q: When `ch.publish()` returns `false` (broker write buffer full), why is "leave the message unacked" the correct recovery — rather than `nack` without requeue (dead-lettering it)?

A: Dead-lettering would permanently discard a message just because the broker was temporarily under load — an overreaction to a transient condition. Leaving it unacked holds the prefetch slot occupied, which correctly applies backpressure to this consumer: under flow control, the consumer should slow down. RabbitMQ redelivers the original once the channel drains, with no message loss.

Extra: EventHorizon · Phase 10 · Challenge: ch.publish() Silent Drop
See: docs/journal/eventhorizon-2026-05-14T0900-silent-message-drop.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-10, nodejs, anti-pattern]
---
Any synchronous function returning a `boolean` in a write path is communicating {{c1::flow control state}}. Examples: `socket.write()`, `stream.write()`, `ws.send()` (bufferedAmount), `channel.publish()`. Discarding these signals is safe only when {{c2::message loss}} is acceptable — which in an at-least-once delivery pipeline, it is not.

Extra: EventHorizon · Phase 10 · Anti-Pattern Avoided: Ignoring Write-Buffer Signals (Flow Control Blindness)
See: docs/journal/eventhorizon-2026-05-14T0900-silent-message-drop.md
