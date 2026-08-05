---
id: eventhorizon-2026-03-27T0915-worker-processors
repo: eventhorizon
title: "Processing Plane: Worker + Processors"
date: 2026-03-27
phase: 3
tags: [competing-consumers, prefetch, backpressure, head-of-line-blocking, at-least-once-delivery, idempotent-receiver, pure-functions]
files: [src/processing/worker.ts, src/processors/enrich.ts, src/processors/classify.ts]
---

### Pattern: Competing Consumers

Multiple worker processes consume from the same durable queue simultaneously, via `ch.consume(QUEUE_NAME, handler)` in `src/processing/worker.ts`. The message broker (RabbitMQ) distributes messages across active consumers in round-robin fashion, and no worker knows about the others — the broker is the coordinator. To scale throughput, more worker processes are started; each calls `amqp.connect()` and `ch.consume()` independently, and the broker handles load distribution. This is horizontal scaling with no shared state or coordination code.

### Anti-Pattern Avoided: Unbounded Consumption ("The Prefetch Problem")

Without `channel.prefetch(N)`, the broker pushes all queued messages to the first consumer that connects: a 50,000-message queue would load all 50,000 into that consumer's memory simultaneously, causing memory pressure, head-of-line blocking (slow messages freeze all subsequent messages), and no load distribution (the second worker to connect gets nothing). The fix is `await ch.prefetch(config.WORKER_PREFETCH)` — AMQP `basic.qos` — which caps unacknowledged messages per consumer, so new messages are only delivered after the worker acks existing ones.

### Anti-Pattern Avoided: Head-of-Line Blocking via `requeue=true`

`ch.nack(msg, false, true)` (requeue=true) puts a failed message at the front of the queue. If the message is a poison pill that always fails, it blocks every message behind it indefinitely, and every other consumer also sees it first. The fix: on error, republish to the back of the queue with an incremented `x-retry-count` header, then ack the original; after `MAX_RETRIES`, `ch.nack(msg, false, false)` dead-letters it via the DLX, so the message goes to `events.dead` without blocking anything. This is the `Processing → Retrying → Processing` (requeue) and `Retrying → Failed` (`x-retry-count >= 3` → DLQ) transitions in the pipeline's event-lifecycle state machine.

### Pattern: At-Least-Once Delivery + Idempotent Receiver

At-least-once delivery guarantees a message is delivered, but possibly more than once. The worker acks after processing completes; if it crashes between "processing done" and "ack sent," the broker redelivers the message to another consumer. The receiver (MongoDB insert) must therefore be idempotent — processing the same message twice must produce the same result as processing it once — which the unique index on `{ "raw.id": 1 }` provides, silently absorbing duplicate inserts via error code 11000.

### Decision: Worker Owns Its Own AMQP Connection

`queue.ts` already holds a connection for publishing, raising the question of whether the worker could reuse it. The decision was no — `worker.ts` calls `amqp.connect()` independently — for three reasons: the server (publisher) and the worker are different OS processes and can't share in-memory objects; isolation means a channel error in the publisher doesn't crash the consumer's channel and vice versa; and shutdown independence, since graceful shutdown sequences differ between publisher and consumer.

### Pattern: Pure Function Processors

`enrich()` and `classify()` in `src/processors/enrich.ts` and `src/processors/classify.ts` are pure functions — same input always produces the same output, with no I/O and no side effects. This gives testability (no mocks, stubs, or fake timers — just call the function and assert), composability (processors can be chained, reordered, or replaced without changing the worker's control flow), and debuggability (a wrong classification can be reproduced with a single function call, no queue, MongoDB, or network needed).
