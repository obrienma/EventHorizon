# EventHorizon — Project Context

> **Dual-LLM project**: Primary AI assistant is **Claude Code** (this file). GitHub Copilot context lives in `.github/copilot-instructions.md`. Keep both in sync when updating project context.

EventHorizon is a **Reactive Data Plane** — a TypeScript/Node.js event-driven telemetry pipeline. Its purpose is practicing advanced backend patterns, not domain logic. The plumbing IS the project.

---

## Architecture: Four Named Planes

```
Ingestion Plane  →  Processing Plane  →  Storage Plane  →  Observation Plane
src/ingestion/       src/processing/       src/storage/       src/observation/
```

Data flows **one direction only**. Nothing flows backwards between planes.

| Plane | Responsibility | Key files |
|---|---|---|
| **Ingestion** | HTTP entry, Zod validation, publish to RabbitMQ | `ingestion/event.schema.ts`, `ingestion/event.routes.ts` |
| **Processing** | AMQP consumer, enrich, classify, ack/nack/retry | `processing/queue.ts`, `processing/worker.ts`, `processors/` |
| **Storage** | Append-only MongoDB writes, idempotent inserts | `storage/db.ts`, `storage/event.repository.ts` |
| **Observation** | Change stream → WebSocket push, metrics polling | `observation/changeStream.ts`, `observation/wsServer.ts`, `observation/metrics.ts` |

---

## Hard Invariants — Never Violate These

- **Append-only storage**: MongoDB documents are NEVER updated after insert. `processed` sub-document is written once by the worker on first successful processing.
- **Idempotent inserts**: Unique index `{ "raw.id": 1 }` on the `events` collection. Duplicate key errors (`code 11000`) are silently ignored — not re-thrown.
- **`AppEvent` is the shared contract**: All planes import event types from `src/ingestion/event.schema.ts`. No plane defines its own event shape.
- **`z.infer<>` only**: Types are always derived from Zod schemas — never written by hand alongside a schema.
- **Graceful shutdown order**: Fastify stop → cancel AMQP consumer → finish in-flight message → close change stream → close MongoDB → close AMQP channel + connection → `process.exit(0)`. This exact order prevents message loss.

---

## Stack

| Layer | Tech | Version |
|---|---|---|
| Language | TypeScript strict, NodeNext modules | 6.x |
| Framework | Fastify | 5.x |
| Message broker | RabbitMQ via `amqplib` | 3.x / 0.10.x |
| Database | MongoDB | 7.x |
| Real-time | `@fastify/websocket` (raw WS, no socket.io) | 11.x |
| Validation | Zod (shared across all planes) | 4.x |
| Testing | Vitest + mongodb-memory-server | latest |
| Runtime | Node.js ESM (`"type": "module"`) | 20+ |

---

## RabbitMQ Topology (declared in `processing/queue.ts`)

```
events (topic exchange)
  └── events.work (durable queue, DLX → events.dlx, TTL 30s)
        └── on nack/TTL → events.dlx (fanout exchange)
              └── events.dead (durable queue)

Routing keys: events.pipeline | events.sensor | events.app
Work queue binding: events.# (catches all)
Backpressure: channel.prefetch(WORKER_PREFETCH env var, default 5)
```

Topology declaration is **idempotent** — safe to call on every startup.

## Worker Retry Logic

Application-level retry via `x-retry-count` message header:
- On error: if `x-retry-count < 3` → republish with incremented count
- On error: if `x-retry-count >= 3` → `channel.nack(msg, false, false)` → dead-lettered to `events.dead`
- On success: `channel.ack(msg)`

---

## WebSocket Message Protocol (`observation/wsServer.ts`)

```ts
type WsMessage =
  | { type: "event"; data: StoredEvent }         // fired per change stream insert
  | { type: "stats"; data: StatsPayload }        // broadcast every STATS_PUSH_INTERVAL_MS
  | { type: "ping" }                             // client responds with "pong"
```

`StatsPayload` includes: `totalProcessed`, `failedCount`, `queueDepth`, `queueDepthStatus` (`ok`/`warning`/`critical`), `processingRatePerSec`, `changeStreamLagMs`, `eventTypeDistribution`.

Queue depth thresholds: `QUEUE_DEPTH_WARNING` (default 50) → yellow, `QUEUE_DEPTH_CRITICAL` (default 200) → red.

---

## Environment Variables

All vars in `.env.example`. Validated via Zod in `src/config.ts` — process exits on startup if any are missing/invalid.

Key vars: `MONGO_URI`, `MONGO_DB_NAME`, `RABBITMQ_URL`, `EXCHANGE_NAME`, `QUEUE_NAME`, `DEAD_LETTER_QUEUE`, `WORKER_PREFETCH`, `QUEUE_DEPTH_WARNING`, `QUEUE_DEPTH_CRITICAL`, `STATS_PUSH_INTERVAL_MS`.

---

## Commands

```bash
npm run infra        # docker compose up -d (MongoDB :27017 + RabbitMQ :5672, UI :15672)
npm run infra:down   # docker compose down
npm run dev          # start Fastify server (tsx src/server.ts)
npm run worker       # start AMQP consumer in separate process
npm run seed         # fake event generator (tsx src/seed/producer.ts)
npm test             # vitest run
npm run test:watch   # vitest watch
npm run typecheck    # tsc --noEmit
```

---

## Testing Conventions

- Tests colocated with source: `foo.test.ts` next to `foo.ts`
- Repository tests: `mongodb-memory-server` (no live Mongo needed)
- Route tests: Fastify `inject()` + `vi.mock()` for `publishEvent()`
- Processor tests: pure unit (no I/O)
- **Not automated**: change streams (needs replica set), WS broadcast, graceful shutdown
- Full strategy: [docs/TESTING.md](docs/TESTING.md)

---

## Detailed Documentation

See `docs/` — ARCHITECTURE.md, SERVICES.md, API.md, DEV_GETTING_STARTED.md, TESTING.md, DECISION_LOG.md, diagrams/OVERVIEW.md.

---

## Current Build Status

**Completed:** project scaffold, tsconfig, docker-compose, .env, vitest config, README, all docs, copilot-instructions.md, CLAUDE.md.

**Not yet implemented** (in order):
1. `src/config.ts`
2. `src/ingestion/event.schema.ts`
3. `src/storage/db.ts` + `src/storage/event.repository.ts`
4. `src/processing/queue.ts`
5. `src/ingestion/event.routes.ts`
6. `src/processing/worker.ts` + `processors/enrich.ts` + `processors/classify.ts`
7. `src/observation/changeStream.ts` + `src/observation/wsServer.ts`
8. `src/dashboard/index.html`
9. `src/seed/producer.ts`
10. `src/observation/metrics.ts`
11. Tests (colocated per layer)
12. `src/server.ts` graceful shutdown

---

## Claude Code Workflow Notes

- **Work one step at a time** and pause for confirmation before moving to the next build step.
- **Commit after each logical step** — the user commits manually; don't push.
- **Don't add features beyond what's asked.** No extra error handling, no extra abstractions, no unrequested refactors.
- **No doc files** unless explicitly requested. Update `CLAUDE.md` and `copilot-instructions.md` Build Status section after each completed step.
- TypeScript strict mode means all nullable paths must be handled — don't use `!` non-null assertions unless provably safe.
- ESM (`"type": "module"`) — all imports need explicit `.js` extensions when importing local files (TypeScript resolves `.ts` → `.js` at runtime with NodeNext).
- Update the Build Status section in this file after each completed step.
