# ADR 0005 — Dead-Letter Exchange for Retry and Failure Handling

**Status:** Accepted

---

## Context

The event processing worker can fail — the processor throws an exception, the database is unreachable, or the message is malformed. When a worker fails to process a message, three things could happen:

1. The message is `nack`-ed with `requeue: true` → immediately redelivered to the same worker (potentially causing an infinite tight loop).
2. The message is `nack`-ed with `requeue: false` → discarded.
3. The message is routed to a configured dead-letter exchange for controlled retry or archival.

A system with at-least-once delivery guarantees must handle failure without message loss and without a retry storm.

## Decision

Configure the work queue (`events.work`) with:
- `x-dead-letter-exchange: events.dlx` (a fanout exchange)
- `x-message-ttl: 30000` (30s TTL as a failsafe against stuck messages)

The worker tracks retry attempts via an `x-retry-count` header in the message properties:
- On error: if `x-retry-count < 3` → republish the message with `x-retry-count + 1` (controlled retry without requeue)
- On error: if `x-retry-count >= 3` → `channel.nack(msg, false, false)` → message dead-letters to `events.dlx` → fanout to `events.dead`
- On success: `channel.ack(msg)`

## Rationale

`nack` with `requeue: true` was explicitly rejected. It causes head-of-line blocking: every worker process will repeatedly attempt the same poisoned message, preventing progress on healthy messages queued behind it. This is a well-known anti-pattern in AMQP systems.

Application-level retry counting via `x-retry-count` gives full control over retry behaviour: configurable max attempts, the ability to inspect the count in the Management UI, and the ability to add exponential backoff later without changing the queue topology.

Dead-lettering to `events.dead` creates a permanent, inspectable record of messages that exhausted all retries. An operator can re-inspect, re-publish, or discard these messages manually.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| `nack` with `requeue: true` | Simple | Causes retry storm; head-of-line blocking; no retry limit |
| Separate retry queue with per-attempt TTL (delayed retry) | Built-in delay between retries | Significant topology complexity; requires extra exchanges and queues per retry tier |
| BullMQ's built-in retry | Zero code | Hides the mechanism; does not apply here (see ADR 0003) |

## Consequences

- The worker must read `x-retry-count` from `msg.properties.headers` on every message, defaulting to `0` if absent.
- Messages in `events.dead` are durable and persist until manually cleared.
- The 30s TTL on `events.work` acts as a backstop — a message stuck in "unacked" state (e.g., a crashed worker) will be requeued after 30s.
- Confidence: **High**. This is the standard AMQP dead-letter pattern; well-documented behaviour.
