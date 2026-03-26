# Architecture

EventHorizon is structured as four explicit **planes**, each with a single responsibility. The planes are one-directional: data flows inward through ingestion, down through processing and storage, and out through observation. Nothing flows backwards.

## System Diagram

```mermaid
flowchart TD
    Producer["Seed Producer\n(CLI / HTTP client)"]

    subgraph IP ["Ingestion Plane"]
        Route["POST /events\n(Fastify route)"]
        Zod["Zod\ndiscriminated union\nvalidation"]
        Route --> Zod
    end

    subgraph MQ ["Message Broker"]
        Exchange["RabbitMQ\nevents topic exchange"]
        WorkQ["events.work queue"]
        DLX["Dead Letter Exchange"]
        DLXQ["events.dead queue"]
        Exchange --> WorkQ
        WorkQ -->|"nack (no requeue)"| DLX
        DLX --> DLXQ
    end

    subgraph PP ["Processing Plane"]
        Worker["Worker\nchannel.consume()"]
        Enrich["enrich.ts\nadd timestamps + metadata"]
        Classify["classify.ts\nnormal | warning | critical"]
        Worker --> Enrich --> Classify
    end

    subgraph SP ["Storage Plane"]
        Mongo[("MongoDB\nevents collection\n(append-only)")]
    end

    subgraph OP ["Observation Plane"]
        CS["Change Stream\n(async iterable)"]
        WS["WebSocket Server\n/live"]
        Metrics["Metrics Poller\n(every 5s)"]
        Dashboard["Browser Dashboard\n(vanilla JS)"]
        CS --> WS
        Metrics --> WS
        WS --> Dashboard
    end

    Producer --> Route
    Zod -->|"publish"| Exchange
    WorkQ --> Worker
    Classify -->|"idempotent insert"| Mongo
    Mongo --> CS
```

## The Four Planes

### Ingestion Plane (`src/ingestion/`)

The only entry point for events. Validates incoming JSON against a Zod discriminated union and immediately publishes to the RabbitMQ exchange. The HTTP response returns as soon as the message is confirmed published — processing is fully decoupled.

**Contracts:** `AppEvent` (Zod-inferred type) is the shared type that flows through every subsequent layer.

### Processing Plane (`src/processing/`)

A long-running AMQP consumer. Picked up messages are enriched (timestamps, source metadata) and classified (severity). On success: `channel.ack()` + store. On failure: `channel.nack(msg, false, false)` — the message is refused without requeue, triggering the Dead Letter Exchange.

**Backpressure:** `channel.prefetch(N)` limits how many unacknowledged messages the worker holds at once. When the worker is saturated, RabbitMQ stops delivering. Messages queue up visibly in the Management UI.

### Storage Plane (`src/storage/`)

Append-only. Events are never updated. A unique index on `raw.id` (the UUID from the producer) makes inserts **idempotent** — if a worker retries the same message, the second insert silently fails duplicate-key, not the whole job.

**Schema:** `StoredEvent` = `{ raw: AppEvent, processed: { enrichedAt, classification, tags }, status }`.

### Observation Plane (`src/observation/`)

Three components:

1. **`changeStream.ts`** — opens a MongoDB change stream on the `events` collection, filtered to `insert` operations. Wraps the stream as an `AsyncIterable<ChangeStreamInsertDocument>`. Handles stream close and reconnection.

2. **`wsServer.ts`** — manages connected WebSocket clients. Iterates the change stream and broadcasts each new `StoredEvent` as a `{ type: "event", data }` message. Handles client connect/disconnect without leaking listeners.

3. **`metrics.ts`** — polls RabbitMQ Management API and MongoDB every 5s, computes rolling processing rate from an in-memory ring buffer, and broadcasts `{ type: "stats", data }` to all connected clients.

---

## RabbitMQ Topology

```mermaid
flowchart LR
    P[Producer] -->|"routingKey: events.pipeline\nevents.sensor\nevents.app"| EX

    subgraph RabbitMQ
        EX["events\n(topic exchange)"]
        WQ["events.work\n(durable queue)\nx-dead-letter-exchange: events.dlx\nx-message-ttl: 30000"]
        DLX_EX["events.dlx\n(fanout exchange)"]
        DLQ["events.dead\n(durable queue)"]

        EX -->|"binding: events.#"| WQ
        WQ -->|"nack / TTL expired"| DLX_EX
        DLX_EX --> DLQ
    end

    WQ -->|"prefetch(5)"| Worker
```

**Key decisions:**
- Topic exchange with `events.#` binding — makes adding new event types zero-config (no new bindings needed)
- `x-message-ttl` on the work queue — messages that sit unprocessed for 30s are dead-lettered automatically, preventing indefinite build-up during worker outages
- Worker retries are handled at the application level (up to 3 attempts tracked in the message header `x-retry-count`) before the final `nack`

---

## Data Flow: Sequence

```mermaid
sequenceDiagram
    actor Producer
    participant Route as POST /events
    participant RMQ as RabbitMQ
    participant Worker
    participant Mongo as MongoDB
    participant CS as Change Stream
    participant WS as WebSocket

    Producer->>Route: POST { type, payload, id, timestamp }
    Route->>Route: Zod.parse()
    Route->>RMQ: channel.publish(exchange, routingKey, msg)
    Route-->>Producer: 202 Accepted { eventId }

    RMQ->>Worker: channel.consume()
    Worker->>Worker: enrich() → classify()
    Worker->>Mongo: insertOne() [idempotent]
    Worker->>RMQ: channel.ack()

    Mongo->>CS: change stream insert event
    CS->>WS: emit StoredEvent
    WS->>WS: broadcast to all clients
```

---

## Graceful Shutdown Sequence

```mermaid
sequenceDiagram
    participant OS as SIGTERM / SIGINT
    participant Server as Fastify Server
    participant Worker as AMQP Consumer
    participant CS as Change Stream
    participant Mongo as MongoDB
    participant RMQ as RabbitMQ

    OS->>Server: signal received
    Server->>Server: fastify.close() — stop accepting new requests
    Server->>Worker: cancel consumer tag
    Worker->>Worker: finish processing current message
    Worker->>CS: close change stream
    Worker->>Mongo: mongoClient.close()
    Worker->>RMQ: channel.close() → connection.close()
    Server->>OS: process.exit(0)
```

Order matters: the consumer is cancelled before closing the channel to avoid message loss. MongoDB is closed after the change stream (which depends on the connection).
