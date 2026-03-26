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

---

### `GET /events`

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

Fetch a single stored event by MongoDB `_id`.

**Response `200`:** `StoredEvent`

**Response `404`:** `{ "error": "Event not found" }`

---

### `GET /queues/stats`

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

### `GET /health`

Liveness check. Returns `200` if the server is running; does not check dependency health.

**Response `200`:** `{ "status": "ok", "uptime": 3600 }`

---

## WebSocket: `GET /live`

Upgrade to WebSocket. The server pushes messages; clients only need to respond to `ping`.

**Connection:**
```js
const ws = new WebSocket('ws://localhost:3000/live');
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
