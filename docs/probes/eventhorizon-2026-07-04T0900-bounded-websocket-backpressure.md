---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-20, websocket, backpressure]
cross-ref: observability
---
Q: `broadcast()` already checked `socket.readyState === WebSocket.OPEN` before sending. Why wasn't that enough to prevent unbounded memory growth on a slow client?

A: `readyState` reflects the TCP connection's lifecycle state (connecting/open/closing/closed), not how much data is queued waiting to be flushed to the OS socket buffer. A connection can stay `OPEN` while `socket.bufferedAmount` grows without limit if the remote peer's read loop stalls — `send()` keeps queuing bytes in process memory regardless of `readyState`. The fix reads `bufferedAmount` directly and applies two thresholds (`WS_BUFFERED_AMOUNT_SKIP`, `WS_BUFFERED_AMOUNT_TERMINATE`) rather than relying on connection state alone.

Extra: EventHorizon · Phase 20 · Anti-Pattern Avoided: Unbounded Backpressure Buffering
See: docs/journal/eventhorizon-2026-07-04T0900-bounded-websocket-backpressure.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-20, websocket, backpressure]
cross-ref: observability
---
`broadcast()`'s bufferedAmount check mirrors the bounded-backpressure pattern already used at the RabbitMQ layer (`WORKER_PREFETCH`, `QUEUE_DEPTH_WARNING`/`CRITICAL`): below `WS_BUFFERED_AMOUNT_SKIP` a message sends normally; between the skip and {{c1::WS_BUFFERED_AMOUNT_TERMINATE}} thresholds the message is {{c2::dropped for that client but the connection stays open}}; at or above the terminate threshold the {{c3::connection itself is torn down}}, since a buffer that large means the client will not catch up.

Extra: EventHorizon · Phase 20 · Pattern: Bounded Backpressure via a Skip/Terminate Threshold Pair
See: docs/journal/eventhorizon-2026-07-04T0900-bounded-websocket-backpressure.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-20, architecture, coupling]
cross-ref: observability
---
Q: ADR 0018 rejects both a MongoDB change-stream consumer and a new RabbitMQ queue as ways to give Synapse-L4 durable delivery. Why is the MongoDB option treated as a worse form of coupling than the RabbitMQ option, even though both would solve the same durability problem?

A: A message queue is an explicit interface — the producer publishes to a named exchange/queue and the consumer reads from it, with no knowledge of the producer's internals. Reading EventHorizon's MongoDB collection directly (and writing into its checkpoint collection) instead couples Synapse-L4 to EventHorizon's *private document schema* — an implementation detail never exposed as a contract. Two services reading/writing the same database directly aren't really separable services anymore, regardless of repo boundaries — the shared-database anti-pattern. RabbitMQ was still rejected, but only on cost/benefit grounds (adds an operational dependency for a durability need the current traffic profile doesn't have), not because it's architecturally unsound.

Extra: EventHorizon · Phase 20 · Decision: Accept At-Most-Once Delivery to WebSocket Subscribers Rather Than Add a Durable Transport
See: docs/journal/eventhorizon-2026-07-04T0900-bounded-websocket-backpressure.md
