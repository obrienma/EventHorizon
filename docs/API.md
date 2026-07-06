# API Reference


Base URL: `http://localhost:3000`

---

## HTTP Endpoints

### `POST /events`

Ingest a new event. Validated against the Zod discriminated union. Published to RabbitMQ asynchronously — processing happens in the background.

**Request body** (one of):

```json
// Pipeline event
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-26T12:00:00.000Z",
  "source": "ci-runner-01",
  "type": "pipeline",
  "payload": {
    "pipelineId": "build-42",
    "step": "test",
    "status": "passed",
    "durationMs": 4200
  }
}

// Sensor event
{
  "id": "...",
  "timestamp": "...",
  "source": "sensor-cluster-a",
  "type": "sensor",
  "payload": {
    "sensorId": "temp-07",
    "metric": "temperature",
    "value": 72.4,
    "unit": "fahrenheit"
  }
}

// App telemetry event
{
  "id": "...",
  "timestamp": "...",
  "source": "web-app",
  "type": "app",
  "payload": {
    "action": "user.login",
    "userId": "usr_abc123",
    "meta": { "ip": "127.0.0.1" }
  }
}
```

**Responses:**

| Status | Body | Meaning |
|---|---|---|
| `202` | `{ "eventId": "<uuid>" }` | Accepted, queued for processing |
| `422` | `{ "error": "Validation failed", "issues": [...] }` | Zod validation rejected the body |
| `500` | `{ "error": "..." }` | RabbitMQ publish failed |

> **Tracing:** when a request is part of an OpenTelemetry trace, the active W3C trace context is injected into the published AMQP message headers, so the worker's `event.process` span continues the same trace started here. See [ARCHITECTURE.md](ARCHITECTURE.md#tracing--instrumentation).

---

### `GET /events`

> **⚠️ Not implemented.** No route currently registers `GET /events` — the only ingestion-plane route is `POST /events` above. This section is left as documented-but-not-built; treat it as aspirational, not current behavior.

Paginated list of stored events.

**Query params:**

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | number | `1` | Page number (1-based) |
| `limit` | number | `20` | Results per page (max 100) |
| `type` | string | — | Filter by event type: `pipeline`, `sensor`, `app` |
| `status` | string | — | Filter by status: `queued`, `processed`, `failed` |

**Response `200`:**
```json
{
  "data": [ /* StoredEvent[] */ ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 342,
    "pages": 18
  }
}
```

---

### `GET /events/:id`

> **⚠️ Not implemented.** Use the GraphQL `event(id: ID!)` query below instead — it resolves by `raw.id`, not MongoDB `_id`.

Fetch a single stored event by MongoDB `_id`.

**Response `200`:** `StoredEvent`

**Response `404`:** `{ "error": "Event not found" }`

---

### `GET /queues/stats`

> **⚠️ Not implemented.** Queue depth is available via the GraphQL `stats` query below, or the WS `stats` broadcast.

Current RabbitMQ queue metrics, fetched from the Management API.

**Response `200`:**
```json
{
  "workQueue": {
    "name": "events.work",
    "messageCount": 14,
    "consumerCount": 1,
    "status": "ok"
  },
  "deadLetterQueue": {
    "name": "events.dead",
    "messageCount": 2
  }
}
```

---

### `GET /healthz`

Dependency-aware liveness and readiness probe. Pings MongoDB on every request. Used by k3s liveness and readiness probes.

**Response `200`:**
```json
{ "status": "ok", "mongo": "ok" }
```

**Response `503`** (MongoDB unreachable):
```json
{ "status": "degraded", "mongo": "error: <message>" }
```

---

## WebSocket: `GET /ws`

Upgrade to WebSocket. The server pushes messages; clients only need to respond to `ping`.

**Connection:**
```js
const ws = new WebSocket('ws://localhost:3000/ws');
```

### Inbound messages (server → client)

All messages are JSON-serialized `WsMessage` objects:

```ts
type WsMessage =
  | { type: "event"; data: StoredEvent }
  | { type: "stats"; data: StatsPayload }
  | { type: "ping" }
```

#### `event` message

Fired for every new insert detected by the MongoDB change stream.

```json
{
  "type": "event",
  "data": {
    "_id": "...",
    "raw": { "id": "...", "type": "pipeline", ... },
    "processed": {
      "receivedAt": "2026-03-26T12:00:00.100Z",
      "enrichedAt": "2026-03-26T12:00:00.210Z",
      "classification": "normal",
      "tags": ["pipeline", "passed"]
    },
    "status": "processed"
  }
}
```

#### `stats` message

Broadcast every `STATS_PUSH_INTERVAL_MS` (default 5s).

```json
{
  "type": "stats",
  "data": {
    "totalProcessed": 1024,
    "failedCount": 3,
    "queueDepth": 14,
    "queueDepthStatus": "ok",
    "processingRatePerSec": 2.4,
    "changeStreamLagMs": 85,
    "eventTypeDistribution": {
      "pipeline": 410,
      "sensor": 380,
      "app": 234
    }
  }
}
```

`queueDepthStatus` values:
- `"ok"` — depth below warning threshold
- `"warning"` — depth ≥ `QUEUE_DEPTH_WARNING` (default 50)
- `"critical"` — depth ≥ `QUEUE_DEPTH_CRITICAL` (default 200)

#### `ping` message

Sent periodically. Client should respond with `"pong"` to keep the connection alive.

### Outbound messages (client → server)

| Message | When |
|---|---|
| `"pong"` | In response to a `ping` |

---

## GraphQL: `POST /graphql`

Read-only Apollo Server layer over the Storage plane (ADR 0019 — schema and rationale in full there). One endpoint, not versioned — see [Schema evolution](#schema-evolution) below.

**Request:**
```json
{ "query": "{ stats { totalProcessed failedCount } }" }
```

**`Query` entry points:**

| Field | Returns | Notes |
|---|---|---|
| `event(id: ID!)` | `Event` | Looks up by `raw.id` (UUID), not MongoDB `_id`. `null` if not found. |
| `events(type, status, limit)` | `[Event!]!` | `limit` defaults to 50, hard-capped at 200 regardless of client input. |
| `pipelineRuns(limit)` | `[PipelineRun!]!` | Distinct pipeline IDs; `limit` defaults to 20, hard-capped at 200. |
| `pipelineRun(pipelineId: ID!)` | `PipelineRun` | `null` if no event with that `pipelineId` exists. |
| `stats` | `Stats!` | Same `getStatsSnapshot()` the WS `stats` broadcast uses — one implementation, two callers. |

`Event` is an interface implemented by `PipelineEvent`, `SensorEvent`, `AppTelemetryEvent` — it mirrors the `AppEvent` discriminated union in `ingestion/event.schema.ts` directly, not a separately-invented shape. Reach type-specific fields with inline fragments.

**Example — filtered events + stats in one request:**
```graphql
query {
  events(type: SENSOR, status: PROCESSED, limit: 5) {
    id
    source
    status
    processed { classification tags }
    ... on SensorEvent { sensorId metric value unit }
  }
  stats { totalProcessed failedCount queueDepthStatus }
}
```

```json
{
  "data": {
    "events": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "source": "sensor-cluster-a",
        "status": "PROCESSED",
        "processed": { "classification": "NORMAL", "tags": ["sensor", "temperature"] },
        "sensorId": "temp-07",
        "metric": "temperature",
        "value": 72.4,
        "unit": "fahrenheit"
      }
    ],
    "stats": { "totalProcessed": 1024, "failedCount": 3, "queueDepthStatus": "ok" }
  }
}
```

**Example — `pipelineRuns`, DataLoader-batched:**
```graphql
query {
  pipelineRuns(limit: 10) {
    pipelineId
    latestStepStatus
    steps { step stepStatus durationMs }
  }
}
```

`steps` and `latestStepStatus` for every run requested in one query are resolved through a single per-request `DataLoader` — however many `pipelineRuns` are requested, this costs exactly one batched `$in` query, not one per run. Measured before/after: [docs/journal.md — Phase 23](journal.md#phase-23-graphql-query-api-phase-2-pipelineruns--dataloader).

**Enum casing:** external enum names are `SCREAMING_CASE` (`EventType.SENSOR`, `EventStatus.PROCESSED`, `Classification.NORMAL`) and map 1:1 to the lowercase strings the Zod schema and MongoDB documents already use (`"sensor"`, `"processed"`, `"normal"`) — no separate internal representation to keep in sync.

**No mutations, no subscriptions.** `POST /events` already covers writes; `GET /ws` already covers live push. See ADR 0019 Rationale for why duplicating either through GraphQL was rejected.

### Schema evolution

No URL versioning (`/v1/graphql`, `/v2/graphql`) — this follows the standard GraphQL convention, which differs from REST on purpose. Because a GraphQL client declares exactly which fields it wants, adding new fields or types is non-breaking by construction: existing queries don't ask for them, so they're unaffected. The schema evolves in place at the one `/graphql` endpoint via:

- **Additive changes** — new fields/types, freely.
- **`@deprecated(reason: "...")`** on a field instead of deleting it, giving clients a visible migration window via introspection rather than a hard break.
- Actual removal only once usage monitoring confirms nothing queries the deprecated field.

Renaming a field, changing its type, or removing a required argument are the genuinely breaking moves — those get the deprecation treatment first, never an abrupt change.
