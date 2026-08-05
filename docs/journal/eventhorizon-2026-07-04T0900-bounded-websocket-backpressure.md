---
id: eventhorizon-2026-07-04T0900-bounded-websocket-backpressure
repo: eventhorizon
title: "Bounded WebSocket Backpressure"
date: 2026-07-04
phase: 20
tags: [websocket, backpressure, buffered-amount, shared-database-anti-pattern, at-most-once-delivery, adr]
cross_ref: observability
cross_ref_id: eventhorizon-2026-07-04T0900-bounded-websocket-backpressure
files: [src/observation/wsServer.ts, src/config.ts, .env.example, docs/adr/0018-bounded-websocket-backpressure.md]
---

### Pattern: Bounded Backpressure via a Skip/Terminate Threshold Pair

`broadcast()` checked `socket.readyState` before calling `socket.send()`, but a socket can be `OPEN` while its outbound buffer grows without limit — `readyState` reflects the TCP connection's lifecycle state (connecting/open/closing/closed), not how much data is queued waiting to be flushed to the OS socket buffer. A connection can stay `OPEN` while `socket.bufferedAmount` grows without limit if the remote peer's read loop stalls — `send()` keeps queuing bytes in process memory regardless of `readyState`. The fix reads `socket.bufferedAmount` directly and applies two thresholds, mirroring the `WORKER_PREFETCH`/`QUEUE_DEPTH_WARNING`/`QUEUE_DEPTH_CRITICAL` bounded-backpressure philosophy already used at the RabbitMQ layer: below `WS_BUFFERED_AMOUNT_SKIP` a message sends normally; between `WS_BUFFERED_AMOUNT_SKIP` and `WS_BUFFERED_AMOUNT_TERMINATE` the message is dropped for that client but the connection stays open; at or above `WS_BUFFERED_AMOUNT_TERMINATE` the connection itself is torn down, since a buffer that large means the client is not going to catch up.

### Anti-Pattern Avoided: Unbounded Backpressure Buffering

Without a `bufferedAmount` ceiling, a single slow WebSocket consumer (e.g. a stalled Synapse-L4 read loop) causes EventHorizon's process memory to grow without bound, because every `broadcast()` call keeps queuing bytes behind the stalled connection. The fix trades that unbounded growth for a documented, bounded loss of messages to that one client.

### Decision: Accept At-Most-Once Delivery to WebSocket Subscribers Rather Than Add a Durable Transport

Synapse-L4 (a downstream telemetry consumer) has no replay mechanism if it disconnects or falls behind — messages broadcast during that window are simply gone. Two durable alternatives were considered — a MongoDB change-stream consumer reusing EventHorizon's resume-token/checkpoint pattern, or a new RabbitMQ competing-consumer queue off the existing exchange — and both were rejected in favor of just fixing the memory bug. The MongoDB route was rejected because it couples a downstream service to EventHorizon's private document schema and checkpoint collection — a shared-database anti-pattern, not a contract: a message queue is an explicit interface, where the producer publishes to a named exchange/queue and the consumer reads from it with no knowledge of the producer's internals, whereas reading EventHorizon's MongoDB collection directly (and writing into its checkpoint collection) couples Synapse-L4 to an implementation detail never exposed as a contract — two services reading/writing the same database directly aren't really separable services anymore, regardless of repo boundaries. The RabbitMQ route was rejected only on cost/benefit grounds, not because it's architecturally unsound: tracing the actual demo traffic shows the LLM-fallback path this durability requirement was meant to protect against is unreachable in practice, since the seed producer's malformed-`id` case is already rejected at ingestion with a 422 and never reaches storage or WebSocket consumers. Full reasoning in ADR 0018.
