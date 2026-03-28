# ADR 0003 — RabbitMQ over BullMQ (Redis-backed Queue)

**Status:** Accepted

---

## Context

The processing plane requires an asynchronous job queue to decouple the ingestion endpoint from the event processing worker. Two serious candidates exist in the Node.js ecosystem: BullMQ (backed by Redis) and RabbitMQ (AMQP 0-9-1 protocol).

The project goal is to practice advanced backend patterns, not to minimise infrastructure complexity.

## Decision

Use **RabbitMQ 3.x** via the `amqplib` library (AMQP 0-9-1). Manage the full topology (exchange, queue, bindings, dead-letter exchange) explicitly in code.

## Rationale

RabbitMQ is the industry-standard message broker for AMQP workloads. The concepts it forces you to engage with — exchanges, bindings, routing keys, `ack`/`nack`, `prefetch`, dead-letter exchanges — are directly transferable to professional environments and map onto Kafka, AWS SQS, and Google Pub/Sub conceptually.

BullMQ was the original plan. It has an excellent TypeScript API, a UI (Bull Board), and handles retry logic automatically. These are exactly the reasons it was rejected: the goal is to implement these mechanisms explicitly, not to receive them for free. Using BullMQ would obscure the at-least-once delivery contract, the backpressure mechanism (`channel.prefetch`), and the dead-letter topology behind a library abstraction.

The RabbitMQ Management UI at `localhost:15672` also provides free visual observability of the queue layer during development with zero additional code.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| BullMQ | Excellent TS API; retry/DLQ built-in; simpler ops | Hides AMQP concepts; Redis not as instructive as a real broker |
| `pg-boss` (Postgres-backed) | No extra infra if Postgres already present | Postgres is not in this stack; not relevant to message broker learning |
| AWS SQS / Google Pub/Sub | Real production service | Requires cloud credentials; adds cost; not locally reproducible |
| Kafka (via KafkaJS) | Industry standard for high-throughput streaming | Significant ops overhead; topic/partition model different enough to be a full separate topic |

## Consequences

- Infrastructure requires a running RabbitMQ instance (managed via Docker Compose).
- Retry logic and dead-lettering are implemented explicitly in the worker — not provided by a library (see ADR 0005).
- `amqplib` has quirks with ESM and top-level await: the library only exposes a CommonJS default export; it must be imported as `import amqp from "amqplib"` (default import, not named).
- `channel.prefetch(N)` must be called before consuming to avoid unbounded message delivery (head-of-line blocking).
