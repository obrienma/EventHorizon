---
id: eventhorizon-2026-03-28T0900-storage-plane
repo: eventhorizon
title: "Storage Plane"
date: 2026-03-28
phase: 3
tags: [idempotent-receiver, fail-fast-startup, at-least-once-delivery, write-then-acknowledge, head-of-line-blocking, typescript]
files: [src/storage/db.ts, src/storage/event.repository.ts, src/processing/worker.ts]
---

### Pattern: Idempotent Receiver

An idempotent receiver produces the same result whether it processes a message once or many times — in an at-least-once delivery system, duplicate messages are an expected normal case, not an error. `saveEvent()` and `saveFailedEvent()` in `src/storage/event.repository.ts` rely on a unique index `{ "raw.id": 1 }` on the `events` MongoDB collection, ensuring only one document exists per event ID; a duplicate insert throws MongoDB error code `11000` (duplicate key), which `saveEvent()` catches and silently returns from. Only `11000` is swallowed — all other errors re-throw so the worker's retry logic engages. Catching every `MongoServerError` type would silently ignore real failures (auth errors, disk full, network drop), acking and permanently losing the message; narrow exception handling is load-bearing here.

### Pattern: Fail-Fast Startup

A system that detects invalid preconditions at startup and crashes immediately with a clear error, rather than starting in a degraded state. `startWorker()` calls `connectDb()` before `amqp.connect()` specifically because if the worker connected to RabbitMQ first and MongoDB was unreachable, it would begin consuming and acking messages it cannot persist — silently dropping events. Connecting to MongoDB first means a failure prevents AMQP consumption from ever starting; the broker holds the messages safely until the worker restarts healthy.

### Anti-Pattern Avoided: Blocking the Nack with a Best-Effort Write

In the worker's dead-letter path, if `saveFailedEvent()` throws (e.g. MongoDB is already down when recording the failure), that exception must not propagate up and block `ch.nack()` — if `ch.nack()` never fires, the message stays unacknowledged indefinitely, causing head-of-line blocking: every other message behind it in the prefetch window is also stalled. The fix is `await saveFailedEvent(event).catch(...)`, where the `.catch()` logs and swallows the error, ensuring `ch.nack()` always executes on the next line. The dead-letter write is best-effort; the routing to `events.dead` must be guaranteed.

### Pattern: Save Before Ack (Write-Then-Acknowledge)

In `worker.ts`, `await saveEvent(...)` precedes `ch.ack(msg)`. In an at-least-once delivery system, `ack` is a destructive operation — the broker removes the message from the queue permanently — so it must not be called until the message is durably handled. Flipped (ack-then-write), a crash between the two calls means the message is gone with no retry and no dead-letter: `ch.ack(msg)` deletes it from the broker, and if `await saveEvent(event, ...)` then throws (MongoDB down, disk full, anything), nothing recovers it. Save-before-ack is safe even under redelivery because if `saveEvent` succeeds but the ack is lost in transit, the broker redelivers the message, and the second `saveEvent` call hits the unique index — error 11000, silently ignored. The Idempotent Receiver is the safety net that makes save-before-ack viable; without the unique index, redelivery would cause duplicate documents. The principle: treat `ack` like a `DELETE` on the broker's side, and don't call it until the message is no longer needed. This is the `Processing → Processed` transition in the pipeline's event-lifecycle state machine.

### Anti-Pattern Avoided: Variable Scope Trap (try/catch)

Declaring `const event = EventSchema.parse(raw)` inside the `try` block makes `event` unreachable in the `catch` block, so `saveFailedEvent(event)` in the dead-letter path would fail to compile. The fix hoists `let event: AppEvent | undefined` before the `try`; the assignment `event = EventSchema.parse(raw)` happens inside the try, and in the dead-letter path, `if (event !== undefined)` guards the `saveFailedEvent` call — correctly handling the case where parsing itself was the failure and there is no valid `AppEvent` to save.
