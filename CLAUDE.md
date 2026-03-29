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

**Completed:** project scaffold, tsconfig, docker-compose, .env, vitest config, README, all docs, copilot-instructions.md, CLAUDE.md, `src/config.ts`, `src/ingestion/event.schema.ts`, `src/global.d.ts`, `src/server.ts`, `src/ingestion/event.routes.ts`, `src/processing/queue.ts`, `src/processing/worker.ts`, `src/processors/enrich.ts`, `src/processors/classify.ts`, `src/storage/db.ts`, `src/storage/event.repository.ts`, `src/observation/changeStream.ts`, `src/observation/wsServer.ts`, `src/observation/metrics.ts`.

**Build order: top-down** (start at the entry point, add each layer as it's called)

**Not yet implemented** (in order):
1. ~~`src/processing/queue.ts` — RabbitMQ topology + real `publishEvent()`~~ ✓
2. ~~`src/processing/worker.ts` + `processors/enrich.ts` + `processors/classify.ts`~~ ✓
3. ~~`src/storage/db.ts` + `src/storage/event.repository.ts`~~ ✓
4. ~~`src/observation/changeStream.ts` + `src/observation/wsServer.ts`~~ ✓
5. ~~`src/observation/metrics.ts`~~ ✓
6. `src/seed/producer.ts`
7. `src/dashboard/index.html`
8. Tests colocated per layer (Fastify inject + vi.mock → real mongodb-memory-server at bottom)

**Tests written so far:**
- `src/processors/enrich.test.ts` ✓
- `src/processors/classify.test.ts` ✓
- `src/storage/event.repository.test.ts` ✓ (mongodb-memory-server)
- `src/ingestion/event.routes.test.ts` ✓ (Fastify inject + vi.mock)
- `src/processing/worker.test.ts` ✓ (fixed: Zod v4 UUID validation — test fixture used non-RFC-4122 UUID)
- `src/observation/metrics.test.ts` ✓ (vi.useFakeTimers + vi.setSystemTime for deterministic rate/lag)

---

## Claude Code Workflow Notes

- **Work one step at a time** and pause for confirmation before moving to the next build step.
- **Commit after each logical step** — the user commits manually; don't push.
- **Don't add features beyond what's asked.** No extra error handling, no extra abstractions, no unrequested refactors.
- **No doc files** unless explicitly requested. Update `CLAUDE.md` Build Status section after each completed step.
- **Maintain `LEARNING_LOG.md`**: After each phase, append new entries for every pattern used, anti-pattern avoided, challenge encountered, or design decision made. Use the established entry format (Pattern / Anti-Pattern / Challenge / Decision sections with **Q:**/**A:** flashcard blocks).
- TypeScript strict mode means all nullable paths must be handled — don't use `!` non-null assertions unless provably safe.
- ESM (`"type": "module"`) — all imports need explicit `.js` extensions when importing local files (TypeScript resolves `.ts` → `.js` at runtime with NodeNext).
- Update the Build Status section in this file after each completed step.

## ADR files
Create decision logs according to https://martinfowler.com/bliki/ArchitectureDecisionRecord.html

## Learning & Mentorship Protocol
This project is a learning vehicle for Reactive Data Planes and Distributed Systems.
Follow these rules for every interaction:

1. **Context First:** Before providing code, explain the specific Distributed Systems pattern being used (e.g., Competing Consumers, Idempotent Receiver, or Circuit Breaker).
2. **The "Why" over "How":** For every major implementation (RabbitMQ configuration, MongoDB Change Streams), include a "Design Decision" comment block explaining why this choice is superior to alternatives.
3. **Intentional Friction:** Do not solve 100% of the problem at once. Provide the core architecture and logic, but leave "TODO" blocks for edge-case error handling or specific Zod refinements for me to implement manually.
4. **Code Reviews:** If I provide code, critique it like a Senior Architect. Focus on:
    - Type safety (Zod/TS)
    - Resource leaks (unclosed sockets/channels)
    - Scalability (bottlenecks in the pipeline)
5. **No Hallucinations:** If a library (like `amqplib`) has a specific quirk with ESM or Top-Level Await, point it out explicitly.
6. **Failure Mode First:** Before implementing any component, describe how it fails. What happens when RabbitMQ is unreachable at startup? When MongoDB drops mid-insert? Design for the unhappy path before writing the happy path. Write this to LEARNING_LOG.md.
7. **Vocabulary Enforcement:** Use correct Distributed Systems terminology consistently — *at-least-once delivery*, *competing consumers*, *head-of-line blocking*, *idempotent receiver*. Name the concept formally before using casual language.
8. **Checkpoint Questions:** After each completed phase, ask me to explain back what was built and *why* — e.g. "Why does the worker ack after writing to Mongo, not before?" Forces active recall over passive reading.
9. **Name the Anti-Pattern Avoided:** When a design decision sidesteps a trap (append-only vs. update-in-place, prefetch vs. unbounded consumption), explicitly name the anti-pattern being avoided and the failure mode it prevents.
10. **Ask me if I want to tackle TODOs before completing them**