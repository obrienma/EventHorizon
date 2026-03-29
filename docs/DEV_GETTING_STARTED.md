# Getting Started (Local Development)

## Prerequisites

- Node.js 20+
- Docker + Docker Compose
- Git

## 1. Clone and Install

```bash
git clone git@github.com:obrienma/EventHorizon.git
cd EventHorizon
npm install
```

## 2. Environment

```bash
cp .env.example .env
```

The defaults in `.env.example` work with the Docker Compose setup — no changes needed for local development.

## 3. Start Infrastructure

```bash
npm run infra
```

This starts:
- **MongoDB 7** on `localhost:27017`
- **RabbitMQ 3** on `localhost:5672`
- **RabbitMQ Management UI** on `http://localhost:15672` (login: `guest` / `guest`)

Wait ~10s for RabbitMQ to be ready before starting the app.

**Verify:**
```bash
docker compose ps
# Both services should show "healthy" or "running"
```

## 4. Start the Server

```bash
npm run dev
```

The server declares the RabbitMQ topology and MongoDB indexes on first boot — both operations are idempotent.

```
EventHorizon server running on http://localhost:3000
RabbitMQ connected — exchange: events, queue: events.work
MongoDB connected — db: eventhorizon
Change stream watching events collection
```

## 5. Start the Worker (separate terminal)

```bash
npm run worker
```

The worker connects to RabbitMQ and begins consuming from `events.work`. You can run multiple worker processes — RabbitMQ round-robins messages between consumers automatically.

## 6. Generate Fake Events

```bash
# 2 events/second, all types, run indefinitely
npm run seed -- --rate=2 --type=all

# Pipeline events only, for 60 seconds
npm run seed -- --rate=5 --type=pipeline --duration=60

# Preview event shapes without sending
npm run seed -- --dry-run
```

## 7. Open the Dashboard

> **`src/dashboard/index.html` is not yet implemented.**
>
> To verify the WebSocket connection is working, connect with `wscat` or a browser console:
> ```bash
> npx wscat -c ws://localhost:3000/ws
> ```
> You should receive `{ type: "stats", data: { ... } }` messages every 5 seconds and `{ type: "event", data: { ... } }` messages for each processed insert.

---

## Observing Backpressure

To see backpressure in action:

1. Stop the worker (`Ctrl+C`)
2. Run the seed producer at a high rate: `npm run seed -- --rate=20`
3. Watch the RabbitMQ Management UI — messages pile up in `events.work`
4. The dashboard stats bar shows `queueDepth` increasing (turns yellow at 50, red at 200)
5. Restart the worker — it drains the queue; depth returns to 0

## Viewing Dead-Lettered Messages

Messages that fail processing 3 times end up in `events.dead`.

In the RabbitMQ Management UI:
1. Go to **Queues** → `events.dead`
2. Click **Get Messages** to inspect failures

## Running Tests

```bash
# Run once
npm test

# Watch mode
npm run test:watch
```

Tests use `mongodb-memory-server` — no running MongoDB required.

## Type Checking

```bash
npm run typecheck
```

## Stopping Infrastructure

```bash
npm run infra:down
```

Data is persisted in a Docker volume (`mongo_data`). To fully reset:

```bash
docker compose down -v
```
