---
id: eventhorizon-2026-03-27T0900-rabbitmq-topology
repo: eventhorizon
title: "Processing Plane: RabbitMQ Topology + publishEvent"
date: 2026-03-27
phase: 3
tags: [rabbitmq, publisher-subscriber, durable-topic-exchange, idempotent-topology, amqplib, module-level-side-effects]
files: [src/processing/queue.ts]
---

### Pattern: Publisher-Subscriber with Durable Topic Exchange

The ingestion plane (publisher) sends events to a named exchange without knowing which queues or consumers exist; the processing plane (subscriber) binds a queue to that exchange and receives only the messages matching its binding key. Publisher and subscriber are fully decoupled — neither holds a reference to the other. `publishEvent()` in `queue.ts` is the publisher: it sends to the `events` exchange with routing key `events.<type>`. The work queue consumer is the subscriber, sharing nothing with the publisher except the exchange name and routing key convention. For messages to survive a broker restart, three things must all be true simultaneously: the exchange is declared `durable: true`, the queue is declared `durable: true`, and each message is published with `persistent: true` (`deliveryMode: 2` on the wire). If any one of these is false, messages are lost on restart — a common misconfiguration.

### Pattern: Idempotent Topology Declaration

Exchanges and queues are declared on every startup using `assertExchange()` / `assertQueue()`. If they already exist with the same arguments, the calls are no-ops; if arguments differ, RabbitMQ throws a `406 PRECONDITION_FAILED` error, which is intentional — it prevents silent misconfiguration. `connectQueue()` is called on every server start with no "create only if not exists" flag, since `assert*` is always safe to call. The only danger is changing a queue's arguments (e.g. adding a DLX to an existing queue without deleting it first), which RabbitMQ will reject.

### Failure Mode First: `src/processing/queue.ts`

Designed for the unhappy path before implementation. If RabbitMQ is unreachable at startup, `amqp.connect()` rejects, the error propagates, `server.ts` catches it, and the process calls `process.exit(1)`. If the connection drops mid-run, `amqplib` emits an `'error'` event on the connection/channel — error listeners must be registered, since an unhandled `'error'` event crashes the Node.js process. If `publishEvent()` is called before `connectQueue()`, the channel is `null` and the function throws `Error("Queue not initialised")` — fail loudly rather than silently drop. If `channel.publish()` returns `false`, RabbitMQ's write buffer is full (backpressure); the response is to log a warning and respect the backpressure rather than retry synchronously. If message serialisation fails (`JSON.stringify` throws on circular refs), the error is allowed to propagate — this is a programming error, not a runtime condition.

### Anti-Pattern Avoided: Module-Level Side Effects in Connection Setup

The tempting wrong approach is a top-level `await amqp.connect(config.RABBITMQ_URL)` followed by `export const channel = await connection.createChannel()` at the top of the module. This is wrong because importing the module causes a network connection attempt even in tests, and `vi.mock()` does not prevent a top-level `await` from executing before the mock is installed — any test that imports the file will try to connect to RabbitMQ. The correct approach exports a `connectQueue()` function instead: the module is side-effect-free on import, and the caller (server startup) decides when to connect.
