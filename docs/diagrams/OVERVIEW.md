# EventHorizon — System Overview


High-level Mermaid diagrams for quick reference.

## Full System

```mermaid
flowchart TD
    subgraph External
        P["Seed Producer\n(CLI)"]
        B["Browser\nDashboard"]
        GC["GraphQL\nClient"]
    end

    subgraph EH["EventHorizon"]
        subgraph IP["Ingestion Plane"]
            R["POST /events"]
            Z["Zod Validation"]
        end

        subgraph MQ["Message Broker — RabbitMQ"]
            EX["events\n(topic exchange)"]
            WQ["events.work\n(durable queue)"]
            DLX["events.dlx\n(fanout exchange)"]
            DQ["events.dead\n(durable queue)"]
            EX -->|"events.#"| WQ
            WQ -->|"nack / TTL"| DLX
            DLX --> DQ
        end

        subgraph PP["Processing Plane"]
            W["Worker\nConsumer"]
            EN["enrich()"]
            CL["classify()"]
            W --> EN --> CL
        end

        subgraph SP["Storage Plane"]
            DB[("MongoDB\nevents")]
        end

        subgraph OP["Observation Plane"]
            CS["Change\nStream"]
            WS["WebSocket\nServer"]
            ME["Metrics\nPoller"]
        end

        subgraph QP["Query API (orthogonal read — not a pipeline stage)"]
            GQL["Apollo Server\nPOST /graphql"]
        end
    end

    P -->|"HTTP POST"| R
    R --> Z
    Z -->|"publish"| EX
    WQ -->|"consume"| W
    CL -->|"insertOne"| DB
    DB --> CS
    CS --> WS
    ME -->|"poll RMQ + Mongo"| WS
    WS -->|"push"| B
    GC -->|"query"| GQL
    GQL -->|"find / distinct\n(read-only)"| DB
```

## RabbitMQ Topology

```mermaid
flowchart LR
    PUB[Publisher] -->|"events.pipeline\nevents.sensor\nevents.app"| TE

    subgraph RMQ["RabbitMQ"]
        TE["events\n(topic exchange)"]
        WQ["events.work\ndurable\nDLX: events.dlx\nTTL: 30s"]
        DLE["events.dlx\n(fanout exchange)"]
        DLQ["events.dead\ndurable"]

        TE -->|"binding: events.#"| WQ
        WQ -->|"on nack or TTL"| DLE
        DLE --> DLQ
    end

    WQ -->|"prefetch(5)"| W1["Worker\nInstance 1"]
    WQ -->|"prefetch(5)"| W2["Worker\nInstance 2"]
```

## Event Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Received: POST /events
    Received --> Queued: Zod valid\npublished to RMQ
    Received --> Rejected: Zod invalid\n(422)

    Queued --> Processing: Worker consumes
    Processing --> Processed: enrich+classify\ninsertOne success\nchannel.ack()
    Processing --> Retrying: error\nx-retry-count < 3\nnack + republish

    Retrying --> Processing: requeued
    Retrying --> Failed: x-retry-count >= 3\nnack → DLQ

    Processed --> [*]
    Failed --> [*]
```

## Data Model

```mermaid
classDiagram
    class StoredEvent {
        +_id: ObjectId
        +raw: AppEvent
        +status: processed | failed
        +processed: ProcessedMeta (only when status=processed)
    }
    class AppEvent {
        +id: string (uuid)
        +timestamp: string
        +source: string
        +type: pipeline | sensor | app
        +payload: EventPayload
    }
    class ProcessedMeta {
        +receivedAt: Date
        +enrichedAt: Date
        +classification: normal | warning | critical
        +tags: string[]
    }
    StoredEvent --> AppEvent : raw
    StoredEvent --> ProcessedMeta : processed
```

## GraphQL Query API

Read-only Apollo Server layer over the Storage plane (ADR 0019) — sits beside the pipeline, not inside it; nothing here feeds back into Ingestion/Processing/Storage/Observation.

```mermaid
flowchart LR
    C["GraphQL\nClient"] -->|"POST /graphql"| AS["Apollo Server"]
    AS --> Q1["Query.event / events / stats"]
    AS --> Q2["Query.pipelineRuns / pipelineRun"]

    Q1 -->|"findOne / find"| DB[("MongoDB\nevents")]

    Q2 --> PR["PipelineRun.steps\nlatestStepStatus"]
    PR -->|".load(pipelineId)\n(per request)"| DL["DataLoader\npipelineStepsLoader"]
    DL -->|"one batched\n$in query"| DB
```

`Query.stats` reuses `getStatsSnapshot()` from `observation/metrics.ts` rather than re-querying — one implementation of "what counts as current stats," shared with the WebSocket broadcast interval.

### Schema

`Event` mirrors the same Zod discriminated union (`AppEvent`) the rest of the system already uses — the union tag becomes the interface's `__resolveType` discriminant, not a separately-invented data model.

```mermaid
classDiagram
    class Event {
        <<interface>>
        +id: ID
        +timestamp: String
        +source: String
        +status: EventStatus
        +processed: ProcessedMeta?
    }
    class PipelineEvent {
        +pipelineId: String
        +step: String
        +stepStatus: String
        +durationMs: Int?
    }
    class SensorEvent {
        +sensorId: String
        +metric: String
        +value: Float
        +unit: String
    }
    class AppTelemetryEvent {
        +action: String
        +userId: String?
    }
    class ProcessedMeta {
        +receivedAt: String
        +enrichedAt: String
        +classification: Classification
        +tags: String[]
    }
    class PipelineRun {
        +pipelineId: ID
        +steps: PipelineEvent[]
        +latestStepStatus: String
    }
    Event <|.. PipelineEvent
    Event <|.. SensorEvent
    Event <|.. AppTelemetryEvent
    Event --> ProcessedMeta : processed (null if status=FAILED)
    PipelineRun --> PipelineEvent : steps (DataLoader-batched)
```
