# ADR 0008 — MongoDB Change Stream over Polling

**Status:** Accepted

---

## Context

The observation plane must react to newly stored events and push them to connected WebSocket clients. Two approaches are available: poll the `events` collection on a timer (e.g., every 500ms with a `find({ _id: { $gt: lastSeen } })` query), or subscribe to a MongoDB change stream.

Both approaches can deliver the same end result to clients. The difference is in the architecture, the coupling, and what the implementation teaches.

## Decision

Use a **MongoDB change stream** (`collection.watch()`) in `observation/changeStream.ts`. The change stream emits `insert` events which are forwarded to all connected WebSocket clients. Polling is not used for new-event delivery.

## Rationale

Polling is the wrong abstraction. It inverts the relationship between producer and consumer: instead of the database notifying the consumer when data is available, the consumer repeatedly asks "anything new?" This wastes I/O on empty polls, introduces latency proportional to the polling interval, and adds a time-based coupling to the data pipeline.

Change streams use MongoDB's oplog internally — the same mechanism that powers replica set replication. The consumer registers interest once and receives events as they happen. This is the same conceptual pattern underlying Kafka consumers, CDC (Change Data Capture) pipelines, and Debezium connectors. Learning change streams is learning a transferable pattern.

The implementation also demonstrates Node.js async iterables and the `for await...of` pattern on a database cursor, which is a core async primitive worth understanding directly.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Timer-based polling | Simple; no replica set required | Empty polls waste I/O; latency floor = polling interval; wrong conceptual model |
| Application-level event bus (e.g., `EventEmitter`) | Zero infrastructure; instant delivery | Bypasses MongoDB entirely; does not survive worker restarts or multi-process deployments |
| Kafka CDC (Debezium → Kafka → consumer) | Industry-grade CDC pipeline | Enormous infrastructure overhead; far beyond this project's scope |

## Consequences

- Change streams require MongoDB to be running as a replica set (even a single-node `rs0`). The Docker Compose configuration handles this; it is not default `mongod` behaviour.
- Automated testing for change stream behaviour is **not implemented** — it requires a real replica set, which `mongodb-memory-server` does not support by default. This is verified manually.
- If MongoDB is unavailable, the change stream cursor throws and must be caught in the `changeStream.ts` error handler — the observation plane fails gracefully without crashing the server.
- Resume token recovery is implemented in `changeStream.ts` — see ADR 0011.
- Confidence: **High** for the pattern. The replica set requirement adds ops complexity that is acceptable for this project.
