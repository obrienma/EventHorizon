---
id: eventhorizon-2026-06-03T0900-durable-checkpoint
repo: eventhorizon
title: "Durable Resume Token Checkpoint"
date: 2026-06-03
phase: 11
tags: [durable-checkpoint, mongodb, change-streams, ephemeral-state, fire-and-forget, typescript, k3s]
files: [src/observation/checkpoint.ts, src/observation/changeStream.ts, src/server.ts, src/observation/checkpoint.test.ts]
---

### Pattern: Durable Checkpoint

A checkpoint is an externally persisted record of how far a consumer has processed. Without it, a consumer restart must either replay from the beginning or miss everything since its last run. Kafka commits consumer offsets to an internal topic; Apache Flink snapshots operator state to object storage; Debezium (CDC) persists its WAL position to a dedicated collection. EventHorizon now persists the MongoDB change stream resume token to a `changestream_checkpoints` collection. The mechanism differs by system; the invariant is the same: the checkpoint is written after delivery, so the consumer can always restart and replay anything it might have missed. ADR-0011 had raised a circular dependency concern about persisting the token in MongoDB — needing Mongo to load the token in order to reconnect to Mongo — but that concern collapses: if MongoDB is completely unavailable at startup, the change stream can't be opened regardless of where the token lives, so the token is irrelevant until MongoDB is reachable; once reachable, loading the token and opening the stream are both possible. The "circular dependency" reduces to "if Mongo is down, we wait until it's up," which was already true. No new infrastructure (Redis) is needed.

### Pattern: Oplog Overrun Recovery (`ChangeStreamHistoryLost`)

MongoDB's oplog is a rolling log of write operations with a configurable retention window. If the server (or pod) is down long enough, the oplog rolls past the position encoded in the resume token; reopening the stream with that stale token gets rejected with error code 286 (`ChangeStreamHistoryLost`). With an in-memory token (Phase 9), this failure was theoretically possible but extremely unlikely, since it would require the server to be up, hold the token, and receive no events for the entire oplog TTL while running. With a persisted token that survives pod restarts, it becomes a realistic scenario: a pod down for hours, the oplog rolls, the pod restarts, a stale token is loaded. The fix detects code 286, clears the checkpoint, resets to `null`, and restarts from the current oplog head — accepting the gap. Backoff on oplog overrun is reset, not preserved: the exponential backoff exists to avoid hammering an unavailable MongoDB, but an oplog overrun means MongoDB is healthy — the problem was the stale token, not an outage — so preserving the backoff would add unnecessary delay to a clean recovery, and `retryDelayMs` is reset to `RETRY_BASE_MS` before scheduling the retry.

### Anti-Pattern Avoided: Ephemeral State in a Stateful Consumer

Storing a stateful consumer's position (cursor offset, resume token, byte offset) only in process memory implicitly assumes the consumer will never restart — an assumption k8s/k3s violates routinely through pod evictions, rolling deploys, OOM kills, and node maintenance. This is dangerous specifically here because the change stream is the delivery mechanism for the observation plane: if the token is lost on restart, all events inserted during the outage are permanently invisible to WebSocket clients. MongoDB stores them — they're in `events` — but the change stream cursor never sees them, so the dashboard's live feed and its stored event count diverge with no observable signal to the operator. The fix externalizes the position to a durable store (MongoDB collection, Redis key, local file with a PersistentVolume) and loads it on startup.

### Decision: Fire-and-Forget Checkpoint Writes

`saveResumeToken()` is called fire-and-forget — not awaited — in the change event handler. Awaiting the checkpoint write would add MongoDB round-trip latency to every event delivery, blocking the change stream handler and potentially throttling throughput on high-volume pipelines. The failure mode of a missed write is mild: on the next pod restart, the token is slightly older than the last delivered event, so a few events may be replayed — the idempotent receiver in `event.repository.ts` absorbs duplicates, since those replayed events attempt insert and are silently swallowed by the unique index. The delivery guarantee degrades slightly (at-least-once for the checkpoint, not exactly-once) but never breaks. If fire-and-forget proves too imprecise, the next step is write-ahead — persist the token before delivering the event, then deliver — giving exactly-once checkpoint behaviour at the cost of a synchronous write per event. For most telemetry pipelines the replay cost is low enough that fire-and-forget is the right trade.

### Decision: `col()` Helper for Collection Typing

MongoDB's `getDb().collection()` returns `Collection<Document>` by default, where `_id` is typed as `ObjectId`, so filtering by a string `_id` fails TypeScript. The two options were passing the document type as a generic parameter at each call site, or wrapping in a typed helper. The `col()` helper (`function col() { return getDb().collection<CheckpointDoc>(COLLECTION); }`) centralises the type annotation once — every call site gets the correct `_id: string` filter type without repetition.

### Challenge: TypeScript Collection Typing for `_id`

`getDb().collection(name)` defaults to `Collection<Document>` where `_id: ObjectId`; passing `{ _id: "observation" }` (a string) fails the filter type check. The fix provides the document type generic — `collection<CheckpointDoc>(name)` where `CheckpointDoc._id` is `string` — which required a private `col()` helper in `checkpoint.ts` and an inline type annotation in `checkpoint.test.ts` for the `findOne` verification call.

### Challenge: Async Propagation Through `startChangeStream`

Making `startChangeStream` async changes its return type from `() => Promise<void>` to `Promise<() => Promise<void>>`. The call site in `server.ts` needed `await` added. ESM top-level await in `server.ts` was already in use (for `connectDb`, `ensureIndexes`, `connectQueue`), so the change was one word.
