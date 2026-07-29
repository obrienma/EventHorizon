# Engineering Journal — EventHorizon

Cross-cutting integration entries are in:
\\wsl$\Ubuntu\home\amanda\dev\rhizome-observability\docs\journal.md

Probes (Cloze/Basic/Image Occlusion cards): `docs/probes/phase-N-<name>.md`

---

## Phase 1 — Foundation — 2026-03-26

Files: src/config.ts, src/ingestion/event.schema.ts, src/global.d.ts

### Pattern: Fail-Fast / Boundary Validation

**Where it appears:** `src/config.ts`

**What it is:**
Validate all external inputs (environment variables, config files, API payloads) at the *earliest possible boundary* — before any application logic runs. If validation fails, crash loudly with clear error messages rather than propagating invalid state deeper into the system.

**Why it matters here:**
`config.ts` is the first file executed at startup. If `MONGO_URI` is missing or `WORKER_PREFETCH` is not a valid integer, the process exits immediately with a field-level error message instead of failing silently 30 seconds later with a cryptic MongoDB connection error.

**Design Decision — why Zod over `process.env.X || default`:**
The naive pattern `const port = Number(process.env.PORT) || 3000` has two failure modes:
1. Silent coercion: `Number("abc")` returns `NaN`, which passes the `|| default` check
2. No error reporting: you don't know *which* var failed or *why*

Zod's `safeParse` gives you a structured error array with field paths and messages.

---

### Pattern: Discriminated Union (Sum Type)

**Where it appears:** `src/ingestion/event.schema.ts`

**What it is:**
A type that can be one of several distinct shapes, distinguished by a shared literal field (the *discriminant*). TypeScript can narrow the type based on checking that field, giving exhaustive type safety in switch/if blocks.

**Why it matters here:**
EventHorizon processes three event types: `pipeline`, `sensor`, `app`. Each has different required fields. A discriminated union on `"type"` means:
- The ingestion plane rejects events that don't match any known shape
- The processing plane can switch on `event.raw.type` and get fully-typed access to shape-specific fields
- No `as` casts needed anywhere

```ts
// TypeScript knows event.data is SensorEvent here:
if (event.raw.type === "sensor") {
  event.raw.sensorId; // ✅ typed, no cast
}
```

---

### Pattern: Schema-as-Contract (Single Source of Truth for Types)

**Where it appears:** `src/ingestion/event.schema.ts` — all planes import from here

**What it is:**
Define types *once* as Zod schemas. Derive all TypeScript types from those schemas via `z.infer<typeof Schema>`. Never write a TypeScript interface that duplicates (or approximates) an existing Zod schema.

**Why it matters here:**
Without this pattern, you get drift: the Zod schema validates one shape, the TypeScript type declares another, and they silently diverge. The compiler can't catch this because they're separate declarations.

With `z.infer<>`, the type IS the schema — one definition, zero drift.

**Anti-pattern avoided: Type Duplication / Schema Drift**
```ts
// ❌ BAD — these can silently diverge:
const SensorSchema = z.object({ sensorId: z.string(), value: z.number() });
interface SensorEvent { sensorId: string; value: number; } // hand-written copy

// ✅ GOOD — derived, always in sync:
const SensorSchema = z.object({ sensorId: z.string(), value: z.number() });
type SensorEvent = z.infer<typeof SensorSchema>; // can never drift
```

---

### Challenge: TypeScript 6 + NodeNext — `process` and `console` Not Found

**Phase:** Phase 1 — after writing `src/config.ts`

**Symptom:**
```
error TS2591: Cannot find name 'process'. Do you need to install type definitions for node?
error TS2584: Cannot find name 'console'. Do you need to change your target library?
```

**Root cause:**
TypeScript 6 with `"module": "NodeNext"` treats every `.ts` file containing `import`/`export` as an ES module. `@types/node` v25 declares `process` and `console` as globals inside `declare global {}` blocks — but those augmentations are only applied in **ambient context** (files with no `import`/`export`). Since `config.ts` has imports, it's a module, and the global augmentation doesn't surface.

The `"types": ["node"]` in `tsconfig.json` correctly resolves `@types/node`, but the resolved file's globals don't pierce the module boundary.

**Fix:**
Create `src/global.d.ts` — a file with *no* `import` or `export`, making it an ambient (non-module) declaration file:
```ts
/// <reference types="node" />
```
Because it's ambient, it applies globally to the entire compilation, surfacing `process`, `console`, `Buffer`, etc. across all module files.

---

### Anti-Pattern Avoided: Leaky Abstraction (Wrong `lib` Fix)

**The tempting wrong fix:**
Add `"dom"` to the `lib` array in `tsconfig.json`:
```json
"lib": ["ES2022", "dom"]
```
This works because `dom` declares a `console` global — but it's the *browser's* console, not Node's.

**Why it's wrong:**
This is the **Leaky Abstraction** anti-pattern: you're importing the browser's type universe into a server-side Node.js module. As a result:
- `document`, `window`, `localStorage`, `fetch` (browser version) all typecheck without error
- You lose the signal when code accidentally references browser APIs that won't exist at runtime
- The compiler's job as a correctness guardrail is weakened

**The correct fix:** Surgical ambient reference that pulls in exactly Node's global declarations and nothing else.

---

## Phase 2 — Server Skeleton + Ingestion Route — 2026-03-26

Files: src/server.ts, src/ingestion/event.routes.ts, src/processing/queue.ts (stub), src/ingestion/event.routes.test.ts

### Decision: Top-Down Build Order

**What it is:**
Build starting from the entry point (`server.ts`) and add each collaborator only when the layer above calls it. The opposite is bottom-up (build storage first, then queue, then routes).

**Why top-down here:**
- You always have a running program — `npm run dev` works from step 1
- Each new file has an immediate, visible reason to exist
- Failure modes surface at the boundary you just added, not somewhere deep in the stack

**Tradeoff:**
Early layers need mocks for the layers below them. Bottom-up gives real implementations all the way down but nothing runs end-to-end until the very last file.

---

### Pattern: London-School TDD (Mockist)

**What it is:**
Test each unit in isolation by replacing its collaborators with mocks/stubs. Contrast with Detroit-school (classicist) TDD which uses real implementations wherever possible.

**How it applies here:**

| Layer | Real | Mocked |
|---|---|---|
| `event.routes.ts` test | Fastify `inject()` | `publishEvent` via `vi.mock()` |
| `worker.ts` test | processor logic | `repository.insertOne` |
| `event.repository.ts` test | everything | nothing (mongodb-memory-server) |

The mock boundary moves down as you implement each layer. At the bottom, `mongodb-memory-server` gives you a real implementation with no live infra needed.

---

### Pattern: Validation Boundary

**Where it appears:** `src/ingestion/event.routes.ts`

**What it is:**
A single point in the system where all external input is validated before it can travel further. Downstream code never needs to re-validate — it trusts that anything past this boundary is well-typed.

**Why it matters here:**
The POST /events route is the only entry point for event data. Once `EventSchema.safeParse()` succeeds, the resulting `AppEvent` is a fully-typed, trusted value. RabbitMQ, the worker, MongoDB — none of them need to re-check the shape.

**Anti-pattern avoided: Defensive Validation Spread**
Validating the same data at multiple layers (route → worker → storage) is redundant and inconsistent — each layer may check different fields, creating subtle divergence. One boundary, one source of truth.

**Note:** The route's two outcomes — `202 Accepted` (Zod valid → published to RabbitMQ) and `422` (Zod invalid → rejected) — are the `Received → Queued` / `Received → Rejected` transitions in the pipeline's event-lifecycle state machine (see `docs/diagrams/OVERVIEW.md`, "Event Lifecycle").

---

### Challenge: Zod 4 Strict UUID Validation

**Phase:** Phase 2 — writing test fixtures

**Symptom:**
```
expected 202 to be 422
```
Test was sending `"id": "00000000-0000-0000-0000-000000000001"` — a fake sequential UUID common in test fixtures.

**Root cause:**
Zod 4 enforces RFC 4122 strictly. The UUID version nibble (4th group, first character) must be `1–8`. The nil UUID (`000...000`) and max UUID (`fff...fff`) are the only exceptions. Version `0` is invalid.

Zod 3 was more permissive — this is a breaking change between versions.

**Fix:** Use a real RFC 4122 v4 UUID in fixtures: `"123e4567-e89b-42d3-a456-426614174000"`

---

### Challenge: NVM Default Node Version Not Active in Shell

**Phase:** Phase 2 — running tests for the first time

**Symptom:**
```
SyntaxError: Unexpected token '.'
```
Optional chaining (`?.`) not recognised — Node 12 was active despite NVM default being Node 24.

**Root cause:**
The NVM default is set in `~/.nvm/nvm.sh` and applied by `.bash_profile`. A shell that didn't source `.bash_profile` (e.g. a subprocess or non-login shell) falls back to the system Node, which on this WSL2 machine is v12.

**Fix:** `source ~/.nvm/nvm.sh && nvm use 24` — or ensure the terminal is a login shell that sources `.bash_profile`.

---

## Phase 3 — Processing Plane: RabbitMQ Topology + publishEvent — 2026-03-27

Files: src/processing/queue.ts

### Pattern: Publisher-Subscriber with Durable Topic Exchange

**What it is:**
The ingestion plane (publisher) sends events to a named exchange without knowing which queues or consumers exist. The processing plane (subscriber) binds a queue to that exchange and receives only the messages matching its binding key. Publisher and subscriber are fully decoupled — neither holds a reference to the other.

**Why it matters here:**
`publishEvent()` in `queue.ts` is the publisher. It sends to the `events` exchange with routing key `events.<type>`. The work queue consumer is the subscriber. They share nothing except the exchange name and routing key convention.

**Durability guarantee:**
For messages to survive a broker restart, three things must all be true simultaneously:
1. The exchange is declared `durable: true`
2. The queue is declared `durable: true`
3. Each message is published with `persistent: true` (`deliveryMode: 2` on the wire)

If any one of these is false, messages are lost on restart. This is a common misconfiguration.

---

### Pattern: Idempotent Topology Declaration

**What it is:**
Declare exchanges and queues on every startup using `assertExchange()` / `assertQueue()`. If they already exist with the same arguments, the calls are no-ops. If arguments differ, RabbitMQ throws a `406 PRECONDITION_FAILED` error, which is intentional — it prevents silent misconfiguration.

**Why it matters here:**
`connectQueue()` is called on every server start. There is no "create only if not exists" flag — `assert*` is always safe to call. The only danger is changing a queue's arguments (e.g., adding a DLX to an existing queue without deleting it first) — RabbitMQ will reject the assertion.

---

### Failure Mode First: `src/processing/queue.ts`

Written before implementation — designing for the unhappy path.

| Failure | When | Behaviour |
|---|---|---|
| RabbitMQ unreachable at startup | `amqp.connect()` rejects | Error propagates; `server.ts` catches it; `process.exit(1)` |
| Connection drops mid-run | `amqplib` emits `'error'` on connection/channel | Must register error listeners; unhandled `'error'` event = Node.js crash |
| `publishEvent()` called before `connectQueue()` | Channel is `null` | Throws `Error("Queue not initialised")` — fail loudly, don't silently drop |
| `channel.publish()` returns `false` | RabbitMQ write buffer full (backpressure) | Log warning; respect backpressure; do not retry synchronously |
| Message serialisation fails | `JSON.stringify` throws (circular refs etc.) | Let it throw — this is a programming error, not a runtime condition |

---

### Anti-Pattern Avoided: Module-Level Side Effects in Connection Setup

**The tempting wrong approach:**
```ts
// ❌ BAD — top-level await, connection happens on import
const connection = await amqp.connect(config.RABBITMQ_URL);
export const channel = await connection.createChannel();
```

**Why it's wrong:**
- Importing this module causes a network connection attempt, even in tests
- `vi.mock()` does not prevent top-level `await` from executing before the mock is installed
- Any test that imports from this file will try to connect to RabbitMQ

**The correct approach:**
Export a `connectQueue()` function. The module is side-effect-free on import. The caller (server startup) decides when to connect.

---

## Phase 3 — Processing Plane: Worker + Processors — 2026-03-27

Files: src/processing/worker.ts, src/processors/enrich.ts, src/processors/classify.ts

### Pattern: Competing Consumers

**Where it appears:** `src/processing/worker.ts` — `ch.consume(QUEUE_NAME, handler)`

**What it is:**
Multiple worker processes consume from the same durable queue simultaneously. The message broker (RabbitMQ) distributes messages across active consumers in round-robin fashion. No worker knows about the others — the broker is the coordinator.

**Why it matters here:**
To scale throughput, you start more worker processes. Each calls `amqp.connect()` + `ch.consume()` independently. The broker handles the load distribution. This is horizontal scaling without any shared state or coordination code.

---

### Anti-Pattern Avoided: Unbounded Consumption ("The Prefetch Problem")

**Where it applies:** Any AMQP consumer.

**The anti-pattern:**
Without `channel.prefetch(N)`, the broker pushes ALL queued messages to the first consumer that connects. If the queue has 50,000 messages, all 50,000 are loaded into the consumer's memory simultaneously, causing:
1. Memory pressure / OOM
2. Head-of-line blocking: slow messages freeze all subsequent messages
3. No load distribution: the second worker to connect gets nothing

**The fix:**
`await ch.prefetch(config.WORKER_PREFETCH)` (AMQP `basic.qos`) caps unacknowledged messages per consumer. New messages are only delivered after the worker acks existing ones.

---

### Anti-Pattern Avoided: Head-of-Line Blocking via `requeue=true`

**Where it applies:** Error handling in AMQP consumers.

**The anti-pattern:**
`ch.nack(msg, false, true)` (requeue=true) puts a failed message at the **front** of the queue. If the message is a poison pill (e.g., always fails), it blocks every message behind it indefinitely. All other consumers also see it first.

**The fix:**
On error: republish to the **back** of the queue with an incremented `x-retry-count` header, then ack the original. After `MAX_RETRIES`, `ch.nack(msg, false, false)` dead-letters it via the DLX. The message goes to `events.dead` without blocking anything.

This is the `Processing → Retrying → Processing` (requeue) and `Retrying → Failed` (`x-retry-count >= 3` → DLQ) transitions in the pipeline's event-lifecycle state machine (see `docs/diagrams/OVERVIEW.md`, "Event Lifecycle").

---

### Pattern: At-Least-Once Delivery + Idempotent Receiver

**Where it appears:** `worker.ts` (delivery guarantee) + `event.repository.ts` (storage plane)

**What it is:**
At-least-once delivery means a message is guaranteed to be delivered, but may be delivered more than once. The worker acks AFTER processing completes. If the worker crashes between "processing done" and "ack sent," the broker redelivers the message to another consumer.

The receiver (MongoDB insert) must be **idempotent** — processing the same message twice must produce the same result as processing it once. The unique index on `{ "raw.id": 1 }` absorbs duplicate inserts silently (error code 11000).

---

### Decision: Worker Owns Its Own AMQP Connection

**Context:** `queue.ts` already holds a connection for publishing. Could the worker reuse it?

**Decision:** No — `worker.ts` calls `amqp.connect()` independently.

**Why:**
1. **Separate lifecycles:** The server (publisher) and the worker are different OS processes. They can't share in-memory objects.
2. **Isolation:** A channel error in the publisher doesn't crash the consumer's channel, and vice versa.
3. **Shutdown independence:** Graceful shutdown sequences differ between publisher and consumer.

---

### Pattern: Pure Function Processors

**Where it appears:** `src/processors/enrich.ts`, `src/processors/classify.ts`

**What it is:**
`enrich()` and `classify()` are pure functions: same input always produces same output, no I/O, no side effects.

**Why it matters:**
1. **Testability:** No mocks, no stubs, no fake timers. Just call the function and assert.
2. **Composability:** Processors can be chained, reordered, or replaced without changing the worker's control flow.
3. **Debuggability:** If a classification is wrong, reproduce it with a single function call — no queue, no MongoDB, no network.

---

## Phase 3 — Storage Plane — 2026-03-28

Files: src/storage/db.ts, src/storage/event.repository.ts (wired into src/processing/worker.ts)

### Pattern: Idempotent Receiver

**Where it appears:** `src/storage/event.repository.ts` — `saveEvent()`, `saveFailedEvent()`

**What it is:**
A receiver that produces the same result whether it processes a message once or many times. In the context of at-least-once delivery, duplicate messages are an expected normal case — not an error.

**How it works here:**
A unique index `{ "raw.id": 1 }` on the `events` MongoDB collection ensures only one document per event ID. On a duplicate insert, MongoDB throws error code `11000` (duplicate key). `saveEvent()` catches *only* `11000` and silently returns — all other errors re-throw so the worker's retry logic engages.

**Why only swallow 11000:**
If we caught all `MongoServerError` types, real failures (auth errors, disk full, network drop) would be silently ignored. The message would be acked and permanently lost. Narrow exception handling is load-bearing here.

---

### Pattern: Fail-Fast Startup

**Where it appears:** `startWorker()` — `connectDb()` called before `amqp.connect()`

**What it is:**
A system that detects invalid preconditions at startup and crashes immediately with a clear error, rather than starting in a degraded state.

**Why MongoDB before RabbitMQ:**
If the worker connected to RabbitMQ first and MongoDB was unreachable, it would begin consuming and acking messages it cannot persist — silently dropping events. By connecting to MongoDB first, a failure prevents AMQP consumption from ever starting. The broker holds the messages safely; they'll be delivered when the worker restarts healthy.

---

### Anti-Pattern Avoided: Blocking the Nack with a Best-Effort Write

**Where it appears:** Dead-letter path in the worker's catch block

**What it is:**
When `saveFailedEvent()` throws (e.g., MongoDB is already down when we try to record the failure), we must not let that exception propagate up and block `ch.nack()`. If `ch.nack()` never fires, the message stays unacknowledged indefinitely — head-of-line blocking: all other messages behind it in the prefetch window are also stalled.

**The fix:**
`await saveFailedEvent(event).catch(...)` — the `.catch()` logs and swallows the error, ensuring `ch.nack()` always executes on the line immediately after. The dead-letter write is best-effort; the routing to `events.dead` must be guaranteed.

---

### Pattern: Save Before Ack (Write-Then-Acknowledge)

**Where it appears:** `worker.ts` — `await saveEvent(...)` precedes `ch.ack(msg)`

**What it is:**
In an at-least-once delivery system, `ack` is a destructive operation — the broker removes the message from the queue permanently. You must not call it until you are certain the message has been durably handled.

**The failure mode if flipped (ack-then-write):**
```ts
ch.ack(msg);               // broker deletes the message
await saveEvent(event, …); // throws — MongoDB down, disk full, anything
// message is gone. no retry, no dead-letter. permanently lost.
```

**Why save-before-ack is safe even with redelivery:**
If `saveEvent` succeeds but the `ack` is lost in transit, the broker redelivers the message. The second `saveEvent` call hits the unique index → error code 11000 → silently ignored. The **Idempotent Receiver** is the safety net that makes save-before-ack a viable pattern. Without the unique index, redelivery would cause duplicate documents.

**The principle:**
Treat `ack` like a `DELETE` on the broker's side. Don't call it until you no longer need the message.

This is the `Processing → Processed` transition in the pipeline's event-lifecycle state machine (see `docs/diagrams/OVERVIEW.md`, "Event Lifecycle").

---

### Anti-Pattern Avoided: Variable Scope Trap (try/catch)

**Where it appears:** `event` variable in the worker message handler

**The trap:**
Declaring `const event = EventSchema.parse(raw)` inside the `try` block makes `event` unreachable in the `catch` block. `saveFailedEvent(event)` in the dead-letter path would fail to compile.

**The fix:**
`let event: AppEvent | undefined` is hoisted before the `try`. The assignment `event = EventSchema.parse(raw)` happens inside the try. In the dead-letter path: `if (event !== undefined)` guards the `saveFailedEvent` call — this also correctly handles the case where parsing itself was the failure (no valid `AppEvent` to save).

---

## Phase 4 — Observation Plane — 2026-03-28

Files: src/observation/changeStream.ts, src/observation/wsServer.ts, docker-compose.yml, .env, src/server.ts, src/ingestion/event.routes.test.ts

### Pattern: Event-Driven Push (Change Streams)

**Where it appears:** `src/observation/changeStream.ts`

**What it is:**
Instead of clients asking "are there new events?" on a timer (polling), the system inverts control: MongoDB pushes each committed insert to the observer the moment it appears on the oplog. The observer then fans out to WebSocket clients.

**Why it beats polling:**
A 1-second poll on a busy collection returns all documents since the last check — most already seen. A change stream delivers exactly one notification per insert, with zero redundant reads. Latency also drops from up to `poll_interval` to near-zero.

**The infrastructure requirement:**
Change streams are built on MongoDB's oplog, which only exists on replica set members. A standalone instance has no oplog and throws `MongoServerError` on `watch()`. The fix: run MongoDB as a single-node replica set (`--replSet rs0`). From the application's perspective it is identical to a standalone — one node, same connection string — but it has an oplog.

**`directConnection=true` in the URI:**
When a replica set's member reports its hostname to the driver, it uses the container's internal hostname — not `localhost`. Without `directConnection=true`, the driver performs RS topology discovery and may try to connect to the container hostname directly, which fails from the host machine. `directConnection=true` skips discovery and connects to the specified host directly. Change streams still work because the node IS a replica set member.

---

### Pattern: Fan-out

**Where it appears:** `broadcast()` in `src/observation/wsServer.ts`

**What it is:**
One incoming message (a change stream insert event) must be delivered to N connected WebSocket clients. `broadcast()` iterates the client `Map` and calls `socket.send()` on each. Clients are independent — a slow or erroring client is removed and does not block delivery to others.

---

### Anti-Pattern Avoided: Zombie Connections

**Where it appears:** Heartbeat in `registerWsServer()`

**The trap:**
TCP connections can appear open when the remote peer is actually gone (process killed, network partition). Without a heartbeat, the server accumulates stale `Map` entries. Each broadcast iterates them, burning time on sockets that will never receive the message.

**The fix — ping/pong heartbeat:**
Every `PING_INTERVAL_MS` (30s):
1. If `isAlive === false` → zombie: `socket.terminate()`, remove from Map
2. If `isAlive === true` → set `false`, send `{ type: "ping" }`

On receiving `"pong"` from the client: set `isAlive = true`.

A live client resets its flag within 30s. A zombie never responds, gets terminated on the next cycle.

**`Map` over `Set`:** A `Set<WebSocket>` would suffice for broadcast, but zombie detection requires per-client state (`isAlive`). A `Map<WebSocket, boolean>` stores both in one structure.

**`heartbeat.unref()`:** Prevents the `setInterval` from keeping the Node.js event loop alive after all other handles close. Without it, a graceful shutdown would hang waiting for the timer to fire.

---

### Decision: Change Stream Lives in the Server Process, Not the Worker

**The question:** The worker writes events to MongoDB. Why doesn't the change stream also live in the worker, since it's watching those same writes?

**The answer — separate processes, no shared memory:**
The worker and server are separate OS processes. `broadcast()` holds a `Map<WebSocket, boolean>` of live client sockets. Those sockets only exist in the server process's memory. The worker cannot reach them — calling `broadcast()` from the worker is physically impossible without adding another IPC channel.

**MongoDB as the process boundary:**
```
worker process                     server process
──────────────                     ──────────────
RabbitMQ → process → insertOne()   watch(oplog) → broadcast() → WS clients
```
The worker doesn't know the server exists. The server doesn't know the worker exists. They are decoupled through MongoDB — the worker writes, the oplog records it, the change stream picks it up. This is Event-Driven Push applied at the process boundary.

**The alternative is worse:**
If the change stream were in the worker, it would need a way to send events across the process boundary to the server's WebSocket clients. That means another IPC channel — a shared Redis pub/sub, an internal HTTP call, another queue. You would be reinventing a message bus you already have. MongoDB's oplog provides that notification channel for free.

---

## Phase 6 — Bug Fix: Zod v4 UUID Validation — 2026-03-28

Files: src/processing/worker.test.ts

### Challenge: Zod v4 Tightened UUID Validation — Test Fixture UUIDs Silently Broke

**What happened:**
Three worker tests were failing with `saveEvent` never being called and `mockCh.ack` never firing. The test fixture used `id: "00000000-0000-0000-0000-000000000001"` — visually UUID-shaped, accepted by Zod v3. In Zod v4, `z.string().uuid()` validates against the full RFC 4122 spec including version nibble (`[1-8]`) and variant nibble (`[89abAB]`). The fixture ID has `0` in both positions and is not the special nil UUID (`...000`), so it fails parse — and the worker never reaches `saveEvent`.

**Why the failure mode was confusing:**
The tests were asserting `saveEvent` was called zero times, which looks like a mock not being applied — classic `vi.mock()` cross-contamination symptoms. The real cause was upstream: the Zod parse inside the worker threw before the storage call was ever reached. The stderr log showed the ZodError but it was easy to overlook when focused on mock assertion failures.

**The fix:**
Replace the fixture UUID with a proper RFC 4122 v4 UUID: `550e8400-e29b-41d4-a716-446655440000`.

**Anti-pattern avoided — "UUID-shaped" strings in test fixtures:**
Using hand-crafted IDs like `00000000-0000-0000-0000-000000000001` is convenient but not standards-compliant. When a validator enforces the spec strictly, these break silently (no compile error, no obvious test failure message). Use real UUIDs in fixtures — `crypto.randomUUID()` or a well-known valid UUID constant.

---

## Phase 7 — Concepts: Node.js Event Loop Handle Ref-Counting — 2026-03-29

Files: src/observation/metrics.ts, src/observation/wsServer.ts

### Pattern: `timer.unref()` for Background Maintenance Timers

**Where it appears:** `src/observation/metrics.ts` (`startMetrics` interval), `src/observation/wsServer.ts` (heartbeat interval)

**What it is:**
Node.js keeps the process alive as long as there are **ref'd handles** — open sockets, pending I/O, active timers. `setInterval` creates a ref'd handle by default. `.unref()` marks a handle as *background*: it still fires on schedule while other handles are active, but it will not prevent the process from exiting naturally when everything else has closed.

**Why it matters here:**
Both the stats broadcast interval and the WebSocket heartbeat are maintenance timers — they serve the system while it's running but should not *own* the process lifecycle. Without `.unref()`, after shutdown closes Fastify, the change stream, MongoDB, and AMQP, these timers would remain as live handles keeping the event loop spinning indefinitely.

**The nuance:**
In the current shutdown sequence, `stopMetrics()` calls `clearInterval` explicitly and `process.exit(0)` is called unconditionally — so the process exits regardless. `.unref()` is defensive hygiene: if either of those were removed or the code restructured, the timer wouldn't silently become a zombie that blocks natural exit.

**Anti-Pattern Avoided: Timers That Own the Process Lifecycle**
A timer that *should* be background but isn't `.unref()`'d keeps the event loop alive even after all meaningful work is done. The process appears hung — no activity, no exit. This is especially subtle in test environments where the process not exiting causes test runners to timeout.

---

## Phase 8 — Bug Fix: Credentials in fetch URLs — 2026-03-29

Files: src/observation/metrics.ts

### Challenge: Node.js Native `fetch` Rejects Credentials Embedded in URLs

**What happened:**
`RABBITMQ_MANAGEMENT_URL=http://guest:guest@localhost:15672` was passed directly to `fetch()`. Node's native fetch (and the browser Fetch API) threw: `Request cannot be constructed from a URL that includes credentials`. The metrics interval silently swallowed the error and returned `queueDepth: 0` every tick.

**Why fetch rejects them:**
Credentials in a URL (`user:pass@host`) are a legacy HTTP basic auth convention. The Fetch spec explicitly forbids them because they leak into logs, `Referer` headers, and browser history. The correct mechanism is the `Authorization` header.

**The fix:**
Parse the URL with `new URL()` to extract `username` and `password`, strip them from the request URL, and pass `Authorization: Basic <base64>` as a header:
```ts
const base = new URL(config.RABBITMQ_MANAGEMENT_URL);
const auth = Buffer.from(`${base.username}:${base.password}`).toString("base64");
const url  = `${base.protocol}//${base.host}/api/...`;
const res  = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
```

**Anti-Pattern Avoided: Credentials in URLs**
`http://user:pass@host` works in older HTTP clients (curl, axios) that don't enforce the Fetch spec, so it's easy to carry this habit into Node 18+ native fetch or browser code — where it breaks silently or with a cryptic error. Always use `Authorization` headers for HTTP basic auth.

---

## Phase 9 — Change Stream Resume Token Recovery — 2026-04-01

Files: src/observation/changeStream.ts

### Pattern: Change Stream Resume with Resume Token

**What it is:**
MongoDB change streams expose a `_id` field (the *resume token*) on every delivered event. The token encodes the cursor's exact position in the replica set oplog. When you reopen a stream with `{ resumeAfter: lastToken }`, MongoDB replays any events that occurred while the cursor was dead — zero-gap delivery.

**Why it matters:**
Without recovery, a cursor failure (MongoDB restart, network blip, replica set election) silently kills the observation plane. The metrics interval still works (it issues fresh `countDocuments` queries on each tick), so the dashboard *appears* healthy — stats update, connection dot is green — but the event feed freezes. 19,000+ events can process invisibly while the developer thinks the dashboard is broken for a different reason.

**The fix in `changeStream.ts`:**
1. Store `resumeToken` in a closure variable, updated on every `change` event.
2. On `error`: schedule `open()` with exponential backoff, passing `{ resumeAfter: resumeToken }`.
3. On teardown: set `shuttingDown = true` and cancel any pending retry timer *before* closing the stream.

**Why `countDocuments` survives a restart but a change stream doesn't:**
`countDocuments` creates a fresh connection and query on each call — the driver handles reconnection transparently. A change stream is a long-lived cursor pinned to an oplog position. When the cursor is invalidated, you must explicitly reopen it. There is no automatic reconnection for cursors.

---

### Anti-Pattern Avoided: Silent Cursor Death

**The failure mode:**
`stream.on("error")` logs the error but doesn't restart. The cursor is dead. The server keeps running. Stats broadcast every 5s (they use regular queries). The dashboard connection dot stays green. The event feed is frozen. There's no alarm, no crash — just one logged error that scrolls off the screen.

**Why this is deceptive:**
The observation plane has two sub-paths: cursor-based (change stream → event broadcast) and query-based (countDocuments → stats broadcast). A failure in one sub-path doesn't affect the other. From outside the server, you only see the healthy sub-path. This is a class of partial failure that monitoring must be designed to detect explicitly.

---

### Decision: In-Memory Resume Token (Not Persisted)

**Decision:** Store the resume token only in memory, not on disk.

**Why:** Persisting to disk (file, Redis, etc.) means a full server restart can resume from the exact pre-restart position — no events missed across restarts. But it adds file I/O, a startup read path, and failure modes around stale/corrupt token files.

**Trade-off accepted:** A server restart replays nothing (new stream starts from the current oplog head). For this pipeline, the observation plane is best-effort — missing events during a restart is acceptable. In a production system with strict delivery guarantees, you'd persist the token. (Phase 11 revisits this decision and persists the token.)

---

### Challenge: Exponential Backoff + Shutdown Race

**The problem:**
When the cursor errors, we schedule `open()` via `setTimeout`. If the server shuts down during that delay window, the timer fires after MongoDB has already closed — `open()` calls `getDb()` on a dead connection and throws.

**The fix:**
Track the timer reference (`retryTimer`). In the teardown function:
1. Set `shuttingDown = true` first (prevents new timers from being scheduled in the error handler).
2. `clearTimeout(retryTimer)` if it's pending.
3. Then close the stream.

Order matters: setting `shuttingDown` before `clearTimeout` prevents a race where the error handler fires between the `clearTimeout` call and the stream close, scheduling a new timer.

---

### Decision: Resume Token Updated Before Broadcast — At-Most-Once Observation Delivery

The resume token is updated *before* calling `onInsert` (the broadcast). If the server crashes between those two lines, the observation plane's delivery guarantee for that event is **at-most-once**: the token has already advanced past the event, so `resumeAfter: lastToken` on restart skips it, and that event is never broadcast.

This is acceptable because the observation plane is a live-view overlay, not the source of truth. The event is already durably stored in MongoDB — written by the worker, ack'd, append-only. A missed broadcast means one event doesn't appear in the feed for that window. No data is lost.

**Why not flip the order (token after `onInsert`) for at-least-once:**
At-least-once would replay and re-broadcast the event on restart. But the dashboard has no deduplication — the client would render it twice in the feed. For a live event stream, a silent gap is better UX than a visible duplicate.

**The deeper principle:** delivery guarantees should match the plane's contract. The storage plane promises at-least-once (RabbitMQ ack-after-write + idempotent insert absorbs replays). The observation plane promises best-effort push to currently-connected clients. Applying at-least-once to a layer where duplicates are visible and unhandled is the wrong guarantee for the wrong layer.

---

## Phase 8 — Testability Refactor: App Factory — 2026-04-25

Files: src/server.ts (split into src/app.ts + src/server.ts), src/ingestion/event.routes.test.ts

### Anti-Pattern Avoided: Import = Side Effect

**Where it appeared:** `src/server.ts` (original, before split)

**What the anti-pattern is:**
A single module that both exports a value (`app`) *and* executes startup I/O when imported — calling `app.listen()`, `connectDb()`, `connectQueue()`, and `startMetrics()` at module top-level.

**The failure mode it caused:**
The routes test imported `server.ts` to get the `app` instance for `inject()` calls. Importing triggered `app.listen()`, which tried to bind port 3000. When the dev server was already running on that port, the error handler called `process.exit(1)`, killing the entire Vitest worker process — crashing all tests in that file before any test ran.

**Why port 0 would not have fixed it:**
Port 0 (OS-assigned random port) only sidesteps the port collision. It does not prevent `connectDb()`, `connectQueue()`, and `startMetrics()` from firing at import time. Those calls either fail (infrastructure not running in CI) or add real startup latency to every test. The root cause — I/O at import time — remains.

---

### Pattern: App Factory

**Where it appears:** `src/app.ts` + `src/server.ts`

**What it is:**
Split a server module into two distinct responsibilities:
- **`app.ts`** — pure construction: create the Fastify instance, register plugins and routes. No network I/O. Safe to import in any test or context.
- **`server.ts`** — entry point: import `app`, run all startup I/O (DB, queue, change stream, metrics), bind the port, register signal handlers. Never imported by tests.

**Why this is the right boundary:**
Tests using Fastify's `inject()` don't need a real socket. They call the route handler directly through the framework's injection layer. The test only needs the configured `app` object — not a listening server, not a database connection, not a running metrics interval.

**Design Decision — why not keep them in one file with a `start()` function:**
A `start()` function still requires the test to explicitly *not* call it. That's fragile — a future dev might call it, or a test setup might. The split makes the contract structural: `app.ts` *cannot* start a server because it has no `listen()` call. The test importing `app.ts` gets a pure value with no affordance for side effects.

---

## Phase 10 — Bug Fix: Silent Message Drop Under Flow Control — 2026-05-14

Files: src/processing/worker.ts, src/processing/worker.test.ts

### Challenge: `ch.publish()` Silent Drop — Found by Code Review, Not by a Test Failure

**What happened:**
Static analysis of `worker.ts:102` revealed that `ch.publish()` was called but its return value was never captured. `ch.ack(msg)` ran unconditionally on the next line. `amqplib`'s `Channel.publish()` is synchronous and returns a `boolean` — `true` if the message was buffered, `false` if the broker's write buffer was full (flow control / backpressure). When it returns `false`, the message was never queued — but the original was acked anyway. The message is gone.

**Why no test caught it:**
`mockCh.publish` was declared as `vi.fn()`, which returns `undefined` by default. `undefined` is falsy — identical to a `false` return from the real method. Yet the existing tests asserted `mockCh.ack` was called and they passed. This means the tests were accidentally modeling the buggy path (publish returns falsy, ack still fires) and asserting on its (wrong) outcome. The mock had **false fidelity**: it appeared to match the real API but silently described the broken behaviour.

**Root cause:**
`amqplib` follows the Node.js streams convention: `write()`/`publish()` return `false` when the internal write buffer is full, signalling the caller to pause until the `'drain'` event fires. This convention is synchronous and idiomatic in Node.js streams — but easy to miss because every other call in the worker (`ack`, `nack`, `prefetch`) either returns `void` or a `Promise`. `publish()` is the odd one out.

**The fix (two parts):**

1. `worker.ts` — capture the return value; only `ack` the original if `published === true`. If `false`, emit a warning and leave the message unacked — RabbitMQ redelivers it when the consumer is ready.

2. `worker.test.ts` — change the mock default to `mockReturnValue(true)` (matching real amqplib under normal conditions), then add one explicit test that sets `mockReturnValueOnce(false)` and asserts `ack` is NOT called.

**Why "don't ack" is the right recovery for a `false` return:**
The alternative is to `nack` without requeue (dead-letter the message), but that would permanently discard a message just because the broker was temporarily under load — an overreaction. Not acking holds the prefetch slot occupied, which is correct: it applies backpressure to this consumer naturally. Under flow control, the consumer *should* slow down. RabbitMQ will redeliver the original once the channel drains.

---

### Anti-Pattern Avoided: Ignoring Write-Buffer Signals (Flow Control Blindness)

**The anti-pattern:**
Calling `write()`/`publish()`/`send()` in a Node.js streams or AMQP context and discarding the boolean return value. The pattern assumes the write always succeeds, which is true under normal load but false when the receiver applies backpressure.

**Why it's dangerous here specifically:**
The ignored return is followed immediately by `ch.ack()` — a destructive, non-retryable operation. The message is permanently removed from the broker. Unlike a failed MongoDB write (which throws and is caught), a failed `publish()` is silent: no exception, no log, no rejected promise. The only signal is a `false` return that was never read.

**The broader principle:**
Any synchronous function that returns a `boolean` in a write path is communicating flow control state. Common examples: `socket.write()`, `stream.write()`, `ws.send()` (bufferedAmount), `channel.publish()`. Discarding these signals is safe only when message loss is acceptable — which in an at-least-once delivery pipeline, it is not.

---

### Challenge: Mock Fidelity Masked the Bug

The bug was invisible to the existing test suite because the mock's default return value (`undefined`) accidentally modeled the broken code path. No test had ever set `publish` to return `true` and then verified that `ack` fires only in that case. The fix required reasoning about mock fidelity, not just writing a new assertion — the mock default had to change first, or the new test would have passed for the wrong reason.

---

## Phase 11 — Durable Resume Token Checkpoint — 2026-06-03

Files: src/observation/checkpoint.ts (new), src/observation/changeStream.ts, src/server.ts, src/observation/checkpoint.test.ts (new)

### Pattern: Durable Checkpoint

A checkpoint is an externally persisted record of "how far has this consumer processed." Without it, a consumer restart must either replay from the beginning or miss everything since its last run. Kafka commits consumer offsets to an internal topic. Apache Flink snapshots operator state to object storage. Debezium (CDC) persists its WAL position to a dedicated collection. EventHorizon now persists the MongoDB change stream resume token to a `changestream_checkpoints` collection. The mechanism differs by system; the invariant is the same: the checkpoint is written *after* delivery, so the consumer can always restart and replay anything it might have missed.

**Why MongoDB and not Redis (revisiting ADR-0011's "circular dependency" concern):**
ADR-0011 raised a circular dependency concern — needing Mongo to load the token in order to reconnect to Mongo. But if MongoDB is completely unavailable at startup, the change stream can't be opened regardless of where the token lives — the token is irrelevant until MongoDB is reachable. Once reachable, loading the token and opening the stream are both possible. The "circular dependency" collapses to "if Mongo is down, we wait until it's up" — which was already true. No new infrastructure (Redis) is needed.

---

### Pattern: Oplog Overrun Recovery (`ChangeStreamHistoryLost`)

MongoDB's oplog is a rolling log of write operations with a configurable retention window. If the server (or pod) is down long enough, the oplog rolls past the position encoded in the resume token. When the stream is reopened with that stale token, MongoDB rejects it with error code 286 (`ChangeStreamHistoryLost`).

With an in-memory token (Phase 9), this failure was theoretically possible but extremely unlikely — it would require the server to be up, hold the token, and then receive no events for the entire oplog TTL while running. With a persisted token that survives pod restarts, it becomes a realistic scenario: pod is down for hours, oplog rolls, pod restarts, stale token is loaded. The fix is to detect code 286, clear the checkpoint, reset to `null`, and restart from the current oplog head — accepting the gap.

**Backoff on oplog overrun is reset, not preserved:** the exponential backoff exists to avoid hammering an unavailable MongoDB. An oplog overrun means MongoDB is healthy — the problem was the stale token, not an outage. Preserving the backoff would add unnecessary delay to a clean recovery. Reset `retryDelayMs` to `RETRY_BASE_MS` before scheduling the retry.

---

### Anti-Pattern Avoided: Ephemeral State in a Stateful Consumer

**The anti-pattern:**
Storing a stateful consumer's position (cursor offset, resume token, byte offset) only in process memory. The consumer implicitly assumes it will never restart — an assumption that k8s/k3s violates routinely through pod evictions, rolling deploys, OOM kills, and node maintenance.

**Why it's dangerous here specifically:**
The change stream is the delivery mechanism for the observation plane. If the token is lost on restart, all events inserted during the outage are permanently invisible to WebSocket clients. MongoDB stores them — they are in `events` — but the change stream cursor never sees them. The dashboard's "live feed" and its stored event count diverge with no observable signal to the operator.

The fix is to externalize the position to a durable store (MongoDB collection, Redis key, local file with a PersistentVolume) and load it on startup.

---

### Decision: Fire-and-Forget Checkpoint Writes

`saveResumeToken()` is called fire-and-forget — not awaited — in the change event handler. Awaiting the checkpoint write would add MongoDB round-trip latency to every event delivery, blocking the change stream handler and potentially throttling throughput on high-volume pipelines.

The failure mode of a missed write is mild: on the next pod restart, the token is slightly older than the last delivered event, so a few events may be replayed. The idempotent receiver in `event.repository.ts` absorbs duplicates — those replayed events attempt insert and are silently swallowed by the unique index. The delivery guarantee degrades slightly (at-least-once for the checkpoint, not exactly-once) but never breaks.

**Next step if fire-and-forget proves too imprecise:** write-ahead — persist the token *before* delivering the event, then deliver. This gives exactly-once checkpoint behaviour at the cost of a synchronous write per event. For most telemetry pipelines the replay cost is low enough that fire-and-forget is the right trade.

---

### Decision: `col()` Helper for Collection Typing

MongoDB's `getDb().collection()` returns `Collection<Document>` by default, where `_id` is typed as `ObjectId`. Filtering by a string `_id` fails TypeScript. Two options: (1) pass the document type as a generic parameter at each call site, (2) wrap in a typed helper. The `col()` helper (`function col() { return getDb().collection<CheckpointDoc>(COLLECTION); }`) centralises the type annotation once. Every call site gets the correct `_id: string` filter type without repetition.

---

### Challenge: TypeScript Collection Typing for `_id`

`getDb().collection(name)` defaults to `Collection<Document>` where `_id: ObjectId`. Passing `{ _id: "observation" }` (a string) fails the filter type check. The fix is to provide the document type generic: `collection<CheckpointDoc>(name)` where `CheckpointDoc._id` is `string`. This required a private `col()` helper in `checkpoint.ts` and an inline type annotation in `checkpoint.test.ts` for the `findOne` verification call.

---

### Challenge: Async Propagation Through `startChangeStream`

Making `startChangeStream` async changes its return type from `() => Promise<void>` to `Promise<() => Promise<void>>`. The call site in `server.ts` needed `await` added. ESM top-level await in `server.ts` was already in use (for `connectDb`, `ensureIndexes`, `connectQueue`), so the change was one word.

---

## Phase 12 — Dockerfile — 2026-06-03

Files: Dockerfile (new), .dockerignore (new), tsconfig.build.json (new), package.json (build script added)

### Pattern: Multi-Stage Docker Build

A single stage that compiles TypeScript would carry devDependencies (`tsx`, `typescript`, `vitest`, `mongodb-memory-server`) into the production image, bloating it by 4–5×. The builder stage installs all dependencies and compiles to `dist/`. The runner stage starts fresh from the same base image, runs `npm ci --omit=dev` (production deps only), and copies only `dist/` from the builder. The final image contains no TypeScript toolchain — only the compiled JS and its runtime dependencies.

---

### Anti-Pattern Avoided: Running as Root in a Container

**The anti-pattern:**
Docker containers run as root by default. In Kubernetes/k3s, many cluster security policies (PodSecurityAdmission, OPA Gatekeeper) reject pods that run as root. Even without policy enforcement, a root process that escapes the container namespace has full host access.

**The fix:**
`RUN addgroup -S app && adduser -S app -G app` in the runner stage creates a system user. `USER app` before `CMD` drops privileges. The `-S` flag creates a system account (no password, no home directory entry in `/etc/passwd` login shell).

---

### Decision: Single Image, Two Entry Points

Server and worker share the entire codebase — same `src/`, same `tsconfig`, same `package.json`. Two Dockerfiles would duplicate the build steps and risk drifting out of sync. One image, two entry points: the server Deployment uses the default `CMD ["node", "dist/server.js"]`; the worker Deployment overrides it with `command: ["node", "dist/processing/worker.js"]` in the k3s manifest. Same image tag, different process, no duplication.

---

### Decision: `tsconfig.build.json` for Production Compilation

`tsconfig.json` includes `src/**/*` which covers `*.test.ts` files. Compiling them into `dist/` is harmless (they're never executed in production) but adds noise and `vitest`/`mongodb-memory-server` imports to the image. `tsconfig.build.json` extends the base and adds `"exclude": ["src/**/*.test.ts"]`, keeping `dist/` clean. The `typecheck` script still uses the root tsconfig so tests remain type-checked in CI.

---

### Challenge: Stale `dist/` From Incremental `tsc`

`tsc` does not delete previously compiled files that are no longer in the compilation scope. Adding `tsconfig.build.json` to exclude test files only prevented new compilations — old `*.test.js` files from previous runs remained in `dist/`. The fix is `rm -rf dist/` before compilation: `"build": "rm -rf dist/ && tsc -p tsconfig.build.json"`. Without the clean step, the first build after adding the exclude would appear to work but silently include stale test artifacts.

---

### Challenge: `dotenv` No-Op in Production

`import "dotenv/config"` in `config.ts` is a no-op when no `.env` file exists (dotenv silently ignores missing files). k3s injects env vars from ConfigMap/Secret references before the process starts, so `process.env` is already populated. The Zod validation then runs against the injected values. Tested: running the worker image without any env vars produces the correct Zod error and exits 1 — the config boundary is working correctly.

---

## Phase 13 — Health Check Endpoint — 2026-06-03

Files: src/health.routes.ts (new), src/app.ts, src/health.routes.test.ts (new)

### Pattern: Dependency-Aware Health Check

A trivial 200 is useless to an orchestrator. k3s liveness probes exist to detect deadlocked or permanently degraded pods so they can be restarted. If `/healthz` always returns 200 even when the MongoDB connection is dead, k3s never restarts the pod and the silent failure persists indefinitely. The probe must touch the actual dependency (`db.command({ ping: 1 })`) to produce a meaningful signal.

**Liveness vs. readiness in k3s:** Liveness asks "Is this process alive and not stuck?" — failure triggers a pod restart. Readiness asks "Is this pod ready to serve traffic?" — failure removes the pod from the Service's endpoint list (stops routing) without restarting it. Readiness is the right tool when startup is slow or when a pod needs to temporarily drain (rolling deploy); liveness is for deadlock detection. A single `/healthz` serving both is standard for simple services; split them only if you need different restart vs. traffic-shedding behaviour.

---

### Anti-Pattern Avoided: Healthcheck Without Dependency Verification

A health route that calls no external dependency is a **vanity probe** — it proves the HTTP server is alive (which Docker/k3s can detect from the TCP connection anyway) but says nothing about whether the app can do useful work. The fix: probe the minimum set of dependencies needed to handle a real request. For the server, that means MongoDB (needed for the change stream and checkpoint reads). For the worker, there is no HTTP server — an exec probe (heartbeat file) or no probe is documented as the alternative.

---

### Decision: Worker Has No HTTP Health Endpoint

The worker process is a pure AMQP consumer — no HTTP server. Adding a minimal HTTP server just for health probing is possible but adds complexity. The pragmatic alternatives: (1) exec probe — worker writes a timestamp to `/tmp/healthy` on each message ack; k3s checks if the file is recent; (2) no probe — rely on process-level restart policies (`restartPolicy: Always`) and the dead-letter queue as the signal for stuck workers. Documented as a TODO in the Deployment manifest.

---

### Challenge: `getDb()` Mock Needed an Explicit Return Value

The existing `event.routes.test.ts` established the exact mock pattern needed (`vi.mock` all module-level dependencies of `app.ts`, import the `app` singleton). Reusing the same pattern for the health route test was straightforward, with one subtlety: the health route calls `getDb().command(...)`, so `getDb` needs a per-test return value (`vi.mocked(getDb).mockReturnValue({ command: vi.fn()... })`), unlike the event route tests where `getDb` is mocked but never called.

---

## Phase 14 — k3s Manifests — 2026-06-03

Files: k3s/namespace.yaml, k3s/configmap.yaml, k3s/secret.yaml, k3s/server.yaml, k3s/worker.yaml (all new)

### Pattern: ConfigMap + Secret Separation

ConfigMaps are stored plaintext in etcd and visible to anyone with `kubectl get configmap`. Secrets are base64-encoded in etcd (not encrypted by default, but can be encrypted at rest with a KMS provider) and have separate RBAC controls. The separation enforces the principle of least privilege: ops tooling that reads ConfigMaps to inspect topology config does not automatically get access to database credentials. `MONGO_URI` and `RABBITMQ_URL` contain passwords — they belong in a Secret. Exchange names, thresholds, and intervals are non-sensitive — they belong in a ConfigMap.

---

### Pattern: Competing Consumers at the Deployment Level

The worker Deployment is set to `replicas: 2`. RabbitMQ distributes messages round-robin across all consumers registered on the queue, so two worker replicas means two concurrent consumers, each processing up to `WORKER_PREFETCH` messages in parallel — double the throughput of a single replica. This is safe because the storage layer is an idempotent receiver: the unique index on `raw.id` ensures that if two workers race to insert the same event (e.g. due to a broker redeliver), one write succeeds and the other is silently swallowed (error 11000). The Competing Consumers pattern was the design goal; the architecture was built to support it from phase one.

---

### Anti-Pattern Avoided: Single-Replica Worker Bottleneck (Single-Consumer Queue)

Leaving `replicas: 1` on the worker Deployment creates a single point of failure and a throughput ceiling. If the worker is slow or briefly unhealthy, the queue depth climbs. With the idempotent insert already in place, there is no correctness reason to restrict to one replica. The pattern name for this anti-pattern is **Single-Consumer Queue** — it converts a scalable message queue into a serialised work queue.

---

### Decision: NodePort for Development, Ingress for Production

The server Service uses `type: NodePort` (port 30080). NodePort makes the service reachable from the host machine without configuring an Ingress controller, which is useful for local k3s development. In production you would use `type: ClusterIP` with an Ingress resource (Traefik, which ships with k3s by default, or nginx-ingress). The Ingress layer adds TLS termination, virtual hosting, and path-based routing — none of which are needed for a development-first learning project.

---

### Decision: No Liveness Probe on the Worker

The worker has no HTTP server, so it cannot be probed via `httpGet`. The options were: (1) add a minimal HTTP server just for the probe, (2) exec probe (worker writes a heartbeat file; probe checks its mtime), (3) rely on `restartPolicy: Always`. Option 3 is chosen for now — if the worker process exits (crash, unhandled rejection), k3s restarts it immediately. The exec probe is documented as a TODO in `worker.yaml` for when silent hangs (channel open but no messages draining) become a concern.

---

## Phase 15 — OTel Instrumentation — 2026-06-06

cross-ref: observability
Files: src/observation/tracing.ts (new), src/server.ts, src/processing/worker.ts, src/processing/queue.ts, src/ingestion/event.routes.ts, src/observation/wsServer.ts, .env.example, docs/adr/0015-otel-sdk-bootstrap-esm-entry-points.md (new), docs/adr/0016-wide-spans-over-prometheus-counters.md (new), docs/DEV_GETTING_STARTED.md, docs/TESTING.md, .observability/OBSERVABILITY_MIGRATION_PLAN.md (new), .observability/phase-3-complete

### Pattern: First-Import SDK Bootstrap (ESM)

`import "./observation/tracing.js"` appears as the first line of each entry point rather than being loaded via an `--import` flag because ESM module evaluation is depth-first, left-to-right: the first import in a module's static import list is fully evaluated before any subsequent import. Placing `tracing.js` first in `server.ts` guarantees `sdk.start()` completes before `app.ts`, `amqplib`, or MongoDB are evaluated. This is a spec-level guarantee, not a tsx or Node implementation detail. The `--import` flag approach works but moves bootstrap responsibility to npm scripts — an easy place to miss when adding a new entry point.

**Why this doesn't break the test suite:** Vitest imports test files and their transitive dependencies directly — it does not go through `server.ts` or `worker.ts`. The `NodeSDK` never calls `sdk.start()` in tests. OTel's `@opentelemetry/api` falls back to a `NoopTracerProvider` when no SDK is registered: `trace.getActiveSpan()` returns `undefined`, `propagation.inject()` is a no-op, `context.with()` just calls the callback. Zero test changes needed.

---

### Pattern: Wide Span Attributes Over Pre-Aggregated Counters

`classification`, `event.type`, `subscribers.count`, and similar values are placed on span attributes rather than incrementing Prometheus counters. A Prometheus counter commits to a specific aggregation at write time — once `events_by_type_total{type="sensor"}` exists, you can only query "how many sensor events total"; you cannot later ask "which sensor events came from source X" because source was not a label. Span attributes are stored raw and queryable in any combination via TraceQL. The tradeoff: TraceQL requires a running Tempo instance; Prometheus counters are queryable without it. The project's posture is: counters only for alerting signals (queue depth, error rate); everything analytics-shaped stays on spans.

---

### Pattern: Async Boundary Context Propagation (RabbitMQ)

Continuing a trace across a RabbitMQ publish/consume boundary uses the W3C TraceContext spec's wire format (`traceparent: 00-<trace-id>-<span-id>-<flags>`). OTel's `propagation.inject(context.active(), carrier)` writes the current span's trace/span ID into a plain object (`carrier`). That object is passed as `properties.headers` in `channel.publish()`. On the consumer side, `propagation.extract(context.active(), carrier)` reconstructs a `Context` containing the parent span reference. Starting a new span with that context as parent produces a child span on the same trace — even though the two spans ran in different processes.

---

### Anti-Pattern Avoided: Silent Error Retry (Treating Parse Failures as Invisible Retries)

Before Phase 15, a message with malformed JSON or a schema mismatch entered the retry loop (retry up to 3×, then dead-letter) with no signal beyond a `console.error`. The same error could recur thousands of times — each instance invisible unless someone was watching logs. The fix: `span.addEvent("message.parse_failed", {...})` on `SyntaxError` and `ZodError` in the worker catch block. The event carries `exception.type`, `exception.message`, `msg.routing_key`, `msg.size_bytes`, and `retry.count`. A TraceQL query `{ name="event.process" && event.name="message.parse_failed" }` now surfaces every parse failure across any time window — groupable by exception type, routing key, or retry count.

---

### Decision: Manual Spans on Business Paths, Auto-Instrumentation as Baseline

Auto-instrumentation (`getNodeAutoInstrumentations()`) covers the low-level I/O: HTTP requests, MongoDB operations, amqplib publish/consume. Manual spans are added only on business-critical operations (`event.process`, `event.observe`) to carry domain attributes that auto-instrumentation cannot know about (`classification`, `subscribers.count`, `changeStream.lag_ms`). The two layers are complementary: auto-instrumentation provides the structural skeleton (how long did the MongoDB write take?); manual attributes provide the analytical slice (what was the classification of the events that caused slow writes?).

Use `trace.getActiveSpan()` to widen a span that a framework or auto-instrumentation already created — adding attributes to the Fastify HTTP span in `event.routes.ts` is the example here. Use `tracer.startSpan()` when you need a new named span with its own start/end times and a specific parent context — the `event.process` CONSUMER span in `worker.ts` is the example.

---

### Decision: No pino Migration (Phase 5 Scope)

The plan recommended replacing `console.*` with pino + `@opentelemetry/instrumentation-pino` for structured log export to Loki. This was deferred. Traces are the high-value signal for this phase; log correlation (Tempo trace ID → Loki log line) requires a running Loki pipeline and is addressed in Phase 5. Keeping `console.*` for now avoids a dependency added for infrastructure that isn't running yet.

---

### Challenge: amqplib Encodes Non-String Header Values as Buffer Objects

When the worker reads `msg.properties.headers`, the `x-retry-count` field (an integer on publish) arrives as a `Buffer` object, not a number or string. Passing the raw headers object directly to `propagation.extract()` would cause the propagator to silently fail (it expects `Record<string, string>`). Fix: filter headers to string-valued keys only before extraction:

```typescript
const carrier: Record<string, string> = {};
for (const [k, v] of Object.entries(msgHeaders)) {
  if (typeof v === "string") carrier[k] = v;
}
const parentCtx = propagation.extract(context.active(), carrier);
```

This preserves `traceparent` (a string) and discards `x-retry-count` (a Buffer). The retry count is read separately from the raw `msgHeaders` object before this filter runs — both concerns are satisfied without interfering.

If the unfiltered headers were passed to `propagation.extract()`, the W3C TraceContext propagator's type check on `headers["traceparent"]` would fail (it's a Buffer, not a string), and extraction would silently return the root (empty) context — the incoming trace orphaned with no error thrown. The span would start as a new root trace instead of continuing the publisher's trace, visible in Tempo as disconnected traces instead of a single parent/child waterfall.

---

## Phase 16 — Live OTel Validation — 2026-06-14

cross-ref: observability
Files: src/ingestion/event.routes.ts

### Pattern: Optional Chaining Short-Circuits Its Entire Argument Tree

`event.routes.ts` called `span?.setAttributes({ "payload.size_bytes": Buffer.byteLength(request.body as string) })`. `request.body` is a parsed object (Fastify's JSON body parser), not a string, so `Buffer.byteLength()` throws `ERR_INVALID_ARG_TYPE` on every call. Yet `npm test` (44/44) never caught it. The reason: `span?.setAttributes(...)` is an *optional* call — when `span` is `undefined`, the optional-chaining operator short-circuits the entire expression, including evaluation of its arguments. `Buffer.byteLength(...)` is never invoked, never throws. The fix is `JSON.stringify(request.body)` before measuring byte length.

---

### Challenge: A Fully-Passing Test Suite Coexisted With a 500 on Every Real Request

In `app.inject()` tests there is no live OTel SDK and no active span — `trace.getActiveSpan()` returns `undefined` (Phase 15's Noop fallback), so `span?.setAttributes(...)` never evaluates its buggy argument. Under `npm run dev` with the real `NodeSDK` running and Fastify's HTTP auto-instrumentation creating a real SERVER span for every request, the same line threw on 100% of `POST /events` calls, returning 500 — the seed producer reported `sent: 0, failed: 8`. The bug was invisible to the test suite by construction, not by oversight, and was discovered only by running the full pipeline against a live OTel Collector (`rhizome-observability`) and watching real traffic 500 out.

---

### Decision: Fix Live-Discovered Bugs Immediately, Even Mid-Validation-Pass

The bug surfaced while validating Phase 15's "definition of done" against the live rhizome-observability stack — a verification activity, not new feature work. It was fixed on the spot (`a9e2e4a`) rather than logged as a follow-up, because a non-functional ingest endpoint made every other verification step (trace propagation, log correlation, metrics scrape) untestable. Phase boundaries are for *planned* work; a bug that blocks the thing currently being validated gets fixed on discovery.

---

### Decision: Service Dashboard Built From Existing Auto-Instrumentation Metrics — No New Instrumentation Code

The "EventHorizon Service" Grafana dashboard (`rhizome-observability/grafana/provisioning/dashboards/eventhorizon-service.json`) — request rate by status code, 5xx error rate, p50/p95/p99 latency, MongoDB connection pool, Node.js event-loop lag, V8 heap, and trace-correlated logs — uses only metrics `auto-instrumentations-node` already exports (`http_server_duration_milliseconds_*`, `db_client_connections_usage`, `nodejs_eventloop_delay_*`, `v8js_memory_heap_used_bytes`). Zero EventHorizon code changes were needed. This is deliberately a Prometheus/RED dashboard, not the TraceQL/wide-span business dashboard the migration plan's Phase 5 envisions (queries over `event.type`/`classification` attributes) — that remains deferred to full Phase 5, per the plan's anti-goal against pre-aggregating business attributes into Prometheus counters. This dashboard answers "is the service healthy"; "what is the service doing" is answered by the Tempo trace waterfall (`Explore → Tempo → {resource.service.name="event-horizon"}`), not by this dashboard.

---

## Phase 17 — Fault Injection for Dashboard Visuals — 2026-06-14

cross-ref: observability
Files: src/config.ts, .env.example, src/ingestion/event.routes.ts, src/seed/producer.ts

### Pattern: Opt-In Fault Injection Behind a Default-Zero Rate

Two independent knobs were added to produce mixed-status traffic for the "EventHorizon Service" dashboard's error-rate panels: `CHAOS_ERROR_RATE` (server, `src/config.ts`/`event.routes.ts`) throws after validation succeeds, producing real 500s and OTel ERROR-status spans; `--error-rate` (seed producer, `src/seed/producer.ts`) sends an otherwise-valid event with `id: "not-a-uuid"`, failing `EventSchema`'s `.uuid()` check and producing real 422s. Both default to `0` and are checked with `Math.random() < rate`. At `rate = 0`, the comparison is always false, so the branch is provably unreachable — `npm test` (`event.routes.test.ts`, 3/3) and normal `npm run dev` traffic are byte-for-byte unchanged from before this phase.

### Decision: Two Independent Knobs Instead of One Combined "Error Mode"

A single `ERROR_RATE` covering both 4xx and 5xx would conflate two different failure domains: 422 is a client-side contract violation (server never starts processing), 500 is a server-side fault (after validation, before the response). Keeping them as separate env var (server) and CLI flag (producer) means each can be tuned independently — e.g. a high `--error-rate` with `CHAOS_ERROR_RATE=0` exercises only the validation path — and the server's chaos knob works against *any* client, not just the seed producer.

cross-ref: observability — the live verification of this fault injection (Tempo `status=error` spans, Prometheus `http_status_code` series for 422/500/202, and the new "Recent Traces" TraceQL panel) is logged in `rhizome-observability/LEARNING_LOG.md`, including two infra-side challenges hit along the way (a WSL2 crash from heavy Grafana-container introspection, and a Grafana 11.2.0 Tempo query-type limitation).

---

## Phase 18 — Custom OTel Metrics — 2026-06-15

cross-ref: observability
Files: src/processing/worker.ts, src/observation/metrics.ts

### Pattern: Promote Already-Sanctioned Metric-Shaped Signals to Exported OTel Instruments

The native dashboard's `StatsPayload` exposes pipeline-internal signals the Grafana "EventHorizon Service" dashboard could not see, because that dashboard is built entirely from HTTP/runtime auto-instrumentation: `queueDepth`, `changeStreamLagMs`, `eventTypeDistribution`, and `failedCount`. Phase 18 exports three OTel instruments so Grafana can render and alert on them. `events.processed` is a `Counter` incremented on the worker's successful-ack path, labeled by `event.type`; the OTLP→Prometheus exporter renders it as `events_processed_total{event_type="pipeline|sensor|app"}`. `events.failed` is its companion `Counter` on the dead-letter path, rendered as `events_failed_total{event_type="..."}` — an always-on async-failure signal the HTTP 5xx panel cannot see, since the 500 surface ends at the `202` and dead-lettering happens later, after retries are exhausted. `eventhorizon.change_stream.lag` is an `ObservableGauge` whose callback, polled on the metric reader's export interval, reports the latest `lastChangeStreamLagMs`; it renders as `eventhorizon_change_stream_lag_milliseconds`. All reuse the `MeterProvider` that `NodeSDK` already auto-configures from `OTEL_*` env vars — no new pipeline wiring, just `metrics.getMeter("eventhorizon")`. `queueDepth` is deliberately *not* added as an EventHorizon metric: it belongs to RabbitMQ's own Prometheus exporter, avoiding a second source of truth. The EventHorizon side of that dependency is now satisfied: the `rabbitmq_prometheus` plugin ships enabled by default in the `rabbitmq:3-management-alpine` image (verified `[E*]`, listening on `15692` inside the container), so the only change required was publishing `15692:15692` in `docker-compose.yml` — done, with the host endpoint verified returning HTTP 200 at `http://localhost:15692/metrics`. The one remaining step is purely in the observability repo: adding the Prometheus scrape job for that target (reachable cross-compose via `host.docker.internal:15692` or a shared network). Until that job is added the RabbitMQ panels stay empty, but the source is live; `queueDepth` also remains available in the in-app dashboard via the Management HTTP API in `metrics.ts`.

### Anti-Pattern Avoided: Inventing a High-Cardinality Counter Label

ADR 0016's core objection to Prometheus counters is that they commit to a label set at write time, so an unbounded dimension (`source`, `id`) becomes a cardinality explosion. Phase 18 sidesteps this by labeling both counters only by `event.type` — a *closed three-value enum* fixed by the discriminated union, with no growth path. `events.failed` adds one bounded fallback, `event_type="unknown"`, for the dead-letter case where parsing itself failed and no typed event exists — keeping the label set closed (four fixed values) rather than reaching for the raw routing key or message id, which would reintroduce the unbounded dimension the ADR warns against. Per-source or per-id breakdowns stay where ADR 0016 puts them: span attributes queried by TraceQL. The counters answer "what is the per-type processed/failed rate" (sampling-independent SLO signals); they do not try to answer "which source emitted this," which remains a trace question.

### Challenge: Reconciling a New Counter With ADR 0016, Which Names That Counter As Its Cautionary Example

ADR 0016 line 21 uses `events_by_type_total{type="sensor"}` as the canonical example of a counter you should *not* create (use a span attribute instead), yet line 37 simultaneously keeps `eventTypeDistribution` as a sanctioned "Prometheus-shaped signal." Adding `events_processed_total` therefore looked like a direct contradiction. The resolution, recorded in ADR 0017, turns on two distinctions ADR 0016 left implicit: (1) traces are *sampled*, so a rate or lag SLO cannot be derived from them without dividing by an unknown sampling ratio — these signals must be always-on instruments; and (2) the change stream is a background watcher with *no span at all* to attach an attribute to. The "alert vs. analyze" test from 0016 still holds; Phase 18 simply adds per-type throughput rate and change-stream lag to the reserved counter/gauge set alongside `queueDepth` and dead-letter rate. `events.failed` needs no reconciliation at all — it *is* the "dead-letter rate" ADR 0016 already named as a reserved counter; Phase 18 merely instruments it.

### Decision: Live-Validate Custom Metrics Rather Than Trust the Wiring

Because `NodeSDK`'s metric export is configured implicitly by env vars (not by explicit code in `tracing.ts`), there was no source-level proof the custom instruments would actually reach the collector. Rather than add a defensive `PeriodicExportingMetricReader` "just in case," the wiring was verified empirically: server + worker started against the live `rhizome-observability` stack, 60 seeded events processed, and Prometheus queried directly — `events_processed_total` returned 25/35/36 split by `event_type` and `eventhorizon_change_stream_lag_milliseconds` returned 0 (expected for a local dev replica set), both carrying `exported_job="event-horizon"`. The existing `http_server_duration` series had already proved the MeterProvider was live; the contingency reader was never needed.

### Challenge: DLQ Depth and `events_failed_total` Disagree By Design

Live dashboard use surfaced an apparent contradiction: `events.dead` held 108 messages while `events_failed_total` read 0. Inspecting the dead messages' `x-death` headers (non-destructively, via the management API with `ackmode=reject_requeue_true`) showed all of them with `reason=expired`, dead-lettered from `events.work` — not `reason=rejected`. The cause: `events.work` carries an `x-message-ttl` of 30s plus a dead-letter exchange, so there are *two* routes into `events.dead`. The worker's explicit `nack` after exhausting retries takes the `rejected` route and runs `failedCounter.add`; broker-level TTL expiry of messages never consumed in time takes the `expired` route, runs no application code, and is therefore never counted. The 108 were backlog that accumulated and expired while the worker was down (a RabbitMQ recreate, a startup race, and a window where a stray producer ran with no consumer). So `events_failed_total` is the *processing-failure* subset of dead-letters, never the total; `rabbitmq_queue_messages{queue="events.dead"}` is the complete signal, and the gap between them is exactly the expired backlog. Confirmed by injecting invalid-JSON poison messages, which took the `rejected` route and produced `events_failed_total{event_type="unknown"}=3` — validating the counter end-to-end (ADR 0017 had noted it was previously unexercised). The lesson: a counter and a queue depth that "should" agree but measure different paths are a feature of the dashboard, not a bug — the discrepancy itself is the signal.

A follow-on dashboard review then found `events_failed_total`'s `event_type` was uniformly `"unknown"` — because the only failures were pre-parse poison, which has no parsed event. Rather than treat that as cosmetic, the right move (a second meta-lesson: query the raw series before judging an `unknown`/`none` legend — it distinguishes a rendering artifact from real data wearing an ugly label) was to add the dimension that *does* carry signal for failures: a closed-cardinality `failure.reason` label (`parse_error | schema_error | processing_error`) derived from the caught error. For failures, *why* beats *what type*, since the dominant mode has no type. Validated live — poison traffic now reports `events_failed_total{failure_reason="parse_error"}`, sliceable by `sum(rate(events_failed_total[5m])) by (failure_reason)`.

---

## Phase 19 — Completing Intentional-Friction TODOs — 2026-06-15

Files: src/processors/classify.ts, src/observation/metrics.ts, src/storage/event.repository.ts, src/processors/classify.test.ts

### Pattern: Stub Tests Encode the Spec the TODO Must Satisfy

Three `// TODO: implement this` blocks left from earlier phases (the `classify` pipeline/sensor branches, `computeRatePerSec`, and `saveEvent`'s insert) had failing tests written *first*, so the tests were an executable specification. `classify` was filled to the assertions (pipeline `failed`→`critical`, sensor temperature `>85`→`critical`/`>70`→`warning`, discriminant carried in `tags`); `saveEvent` was filled by mirroring the already-complete `saveFailedEvent` (`insertOne` with a `code === 11000` swallow), completing the Idempotent Receiver. No behaviour had to be invented — the stubs were filled to make red tests green, nothing more.

### Anti-Pattern Avoided: Read-Stale Rate Window

`computeRatePerSec` could have simply returned `recentInsertTimestamps.length / windowSec`, but the window is only pruned in `recordInsert` (on write). A stalled stream would then report a stale-high rate indefinitely until the next delivery pruned the array. The implementation filters by the cutoff *at read time* as well, so the rate decays to zero on its own when deliveries stop.

### Challenge: `Omit` Does Not Distribute Over a Discriminated Union

The `classify.test.ts` helper `makeEvent(overrides: Omit<AppEvent, "id" | "timestamp">)` failed to typecheck. `AppEvent` is a discriminated union, and `Omit<Union, K>` is *not* distributive: it computes `keyof` over the whole union (the intersection of members' keys) and `Pick`s from that, collapsing the `type`↔`payload` correlation into independent unions — so `{ type: "pipeline", payload: <sensor payload> }` becomes assignable. The fix is a distributive variant, `type DistributiveOmit<T, K> = T extends unknown ? Omit<T, K> : never;`, where the naked `T` in a conditional makes TypeScript apply `Omit` to each union member separately, preserving each variant's discriminant-to-payload binding. This is the same distribution mechanism behind `Exclude`/`Extract`.

### Decision: Fix the Last Typecheck Error Even Though Tests Already Passed

After filling the TODOs, `npm test` was 44/44 green (Vitest transpiles via esbuild and does not type-check), but `npm run typecheck` still failed on the `makeEvent` helper. The helper was fixed rather than left, because the project gates on a clean `tsc --noEmit` — a passing runtime suite that does not type-check is a false green, and the failure was in the file already being edited.

---

## Phase 20 — Bounded WebSocket Backpressure — 2026-07-04

cross-ref: observability

Files: src/observation/wsServer.ts, src/config.ts, .env.example, docs/adr/0018-bounded-websocket-backpressure.md

### Pattern: Bounded Backpressure via a Skip/Terminate Threshold Pair

`broadcast()` checked `socket.readyState` before calling `socket.send()`, but a socket can be `OPEN` while its outbound buffer grows without limit — `readyState` reflects the TCP connection state, not how much unsent data is queued behind it. The fix reads `socket.bufferedAmount` and applies two thresholds, mirroring the `WORKER_PREFETCH`/`QUEUE_DEPTH_WARNING`/`QUEUE_DEPTH_CRITICAL` bounded-backpressure philosophy already used at the RabbitMQ layer: below `WS_BUFFERED_AMOUNT_SKIP` a message sends normally; between `WS_BUFFERED_AMOUNT_SKIP` and `WS_BUFFERED_AMOUNT_TERMINATE` the message is dropped for that client but the connection stays open; at or above `WS_BUFFERED_AMOUNT_TERMINATE` the connection itself is torn down, since a buffer that large means the client is not going to catch up.

### Anti-Pattern Avoided: Unbounded Backpressure Buffering

Without a `bufferedAmount` ceiling, a single slow WebSocket consumer (e.g. a stalled Synapse-L4 read loop) causes EventHorizon's process memory to grow without bound, because every `broadcast()` call keeps queuing bytes behind the stalled connection. The fix trades that unbounded growth for a documented, bounded loss of messages to that one client.

### Decision: Accept At-Most-Once Delivery to WebSocket Subscribers Rather Than Add a Durable Transport

Synapse-L4 (a downstream telemetry consumer) has no replay mechanism if it disconnects or falls behind — messages broadcast during that window are simply gone. Two durable alternatives were considered — a MongoDB change-stream consumer reusing EventHorizon's resume-token/checkpoint pattern, or a new RabbitMQ competing-consumer queue off the existing exchange — and both were rejected in favor of just fixing the memory bug. The MongoDB route was rejected because it couples a downstream service to EventHorizon's private document schema and checkpoint collection — a shared-database anti-pattern, not a contract. The RabbitMQ route was rejected only because it was unnecessary right now: tracing the actual demo traffic shows the LLM-fallback path this durability requirement was meant to protect against is unreachable in practice, since the seed producer's malformed-`id` case is already rejected at ingestion with a 422 and never reaches storage or WebSocket consumers. Full reasoning in ADR 0018.

---

## Phase 21 — GraphQL Query API, Phase 0 (Scaffold) — 2026-07-06

Files: src/graphql/schema.ts, src/graphql/resolvers.ts, src/graphql/loaders.ts, src/graphql/plugin.ts, src/app.ts, package.json, docs/adr/0019-graphql-query-api-over-fastify.md, .claude/plans/graphql-query-api.md

### Pattern: Prove the Integration Boots Before Writing Real Resolvers

Per `.claude/plans/graphql-query-api.md` Phase 0, the schema was kept to a single `Query.health: String!` field returning `"ok"` and wired end-to-end (`registerGraphQL(app)` alongside the existing `registerWsServer(app)` in `app.ts`) before any of ADR 0019's real schema or resolvers were written. This isolates "does the Apollo/Fastify integration actually work" from "are the resolvers correct" — if the boot check had failed, the failure would unambiguously be in the integration layer, not buried under real query logic.

### Decision: Apollo Server's Fastify Integration Confidence Upgraded from Medium to High

ADR 0019 flagged `@as-integrations/fastify` as Medium confidence — a thinner, less battle-tested integration than Apollo's Express path — and asked for early validation rather than assumed correctness. The Phase 0 boot check (`apollo.start()` → `app.register(fastifyApollo(apollo))` → live `curl -X POST /graphql` against local infra returning `{"data":{"health":"ok"}}`) hit no rough edges: no version mismatch, no missing drain-plugin wiring, no context-function surprises. No probe entry was written for this phase, per the plan's own instruction to only document the scaffold step if it wasn't a straight line.

### Challenges

None. The scaffold matched the ADR's plan exactly; `tsc --noEmit` and the full Vitest suite (44/44) stayed green with no changes needed outside the new `src/graphql/` files and `app.ts`'s single new import/await pair.

---

## Phase 22 — GraphQL Query API, Phase 1 (Real Schema/Resolvers) — 2026-07-06

Files: src/graphql/schema.ts, src/graphql/resolvers.ts, src/observation/metrics.ts, docs/adr/0019-graphql-query-api-over-fastify.md

### Pattern: GraphQL Enum Value Maps Instead of Manual Case Conversion

The Zod schema and MongoDB documents use lowercase internal values (`"pipeline"`, `"processed"`, `"normal"`) while the ADR's schema specifies uppercase GraphQL enum names (`PIPELINE`, `PROCESSED`, `NORMAL`) as is conventional for GraphQL SDL. Rather than writing resolver code to uppercase output values and lowercase input args, `resolvers.ts` exports `EventType`/`EventStatus`/`Classification` value maps (e.g. `{ PIPELINE: "pipeline", SENSOR: "sensor", APP: "app" }`) — Apollo translates between the external enum name and the internal value automatically in both directions. Query arg filters (`events(type: SENSOR)`) and field resolvers (`status: (doc) => doc.status`) both pass the internal lowercase string straight through with zero case-conversion logic.

### Pattern: Extract Shared Query Logic Instead of Duplicating It

`Query.stats` needed the same totals/queueDepth/rate/lag assembly that `startMetrics`'s broadcast interval already computed. Rather than reimplementing that aggregation in `resolvers.ts`, `metrics.ts` now exports `getStatsSnapshot(): Promise<StatsPayload>` — the interval's body was reduced to `await getStatsSnapshot()` followed by the broadcast call, and the GraphQL resolver calls the same function. One implementation of "what counts as the current stats," two callers.

### Anti-Pattern Avoided: Type Narrowing Silently Assumed Correct

`Event.__resolveType` tells GraphQL which concrete resolver map to call (`PipelineEvent`, `SensorEvent`, `AppTelemetryEvent`), but it doesn't narrow TypeScript's view of `doc.raw` inside those maps — the parent object is still typed as the full `StoredEvent` union. `pipelinePayload()`/`sensorPayload()`/`appPayload()` helpers narrow explicitly and throw if the discriminant doesn't match the expected type. The throw is unreachable in correct operation (it would mean `__resolveType` and a field resolver disagree), but it makes the payload accessors total functions rather than ones that silently return `undefined` or produce a runtime type error deeper in the call stack.

### Decision: Add `processed: ProcessedMeta` to the Event Interface Before Writing Resolvers

ADR 0019's schema defined a `ProcessedMeta` GraphQL type but never referenced it as a field anywhere, while the companion plan's Phase 1 instructions explicitly said field resolvers should read from `processed.*` on the stored document — an internal inconsistency between the ADR and its own implementation plan. Rather than silently picking a placement, this was surfaced to the user before writing any resolver code; the resolved design adds a nullable `processed: ProcessedMeta` field to the `Event` interface and all three concrete types (null for `status: FAILED` documents, since failed `StoredEvent`s have no `processed` sub-document at all). ADR 0019 was amended in place — it is still `Proposed`, so no formal revision-history entry was needed.

### Decision: Hard-Cap `events(limit)` Regardless of Client Input

The schema's `events(limit: Int = 50)` argument is client-supplied. Without a ceiling, a client requesting `limit: 1000000` would force an unbounded collection scan. `resolvers.ts` clamps with `Math.min(args.limit ?? 50, 200)` — the default stays ADR-specified, but 200 is a hard floor no request can exceed, matching the ADR's Consequences note that complexity/depth limiting is deferred but shouldn't be silently forgotten.

### Challenges

None blocking. The live verification (Fastify `inject()` against real Mongo data, bypassing RabbitMQ/worker entirely by writing `StoredEvent`s directly via `saveEvent`/`saveFailedEvent`) surfaced one environment risk worth recording: running the full `server.ts` + `worker.ts` dev processes simultaneously pushed WSL2 memory to 6.4/7.6GB used with swap fully exhausted, causing both processes to hang silently past their normal ~2s boot time. Killed both before the OOM crash this project's memory notes already warn about, and re-verified with a single lightweight script (`app.inject()`, no live `.listen()`, no OTel/RabbitMQ bootstrap) instead — a lighter path worth defaulting to for future verification passes in this environment.

---

## Phase 23 — GraphQL Query API, Phase 2 (pipelineRuns + DataLoader) — 2026-07-06

Files: src/graphql/loaders.ts, src/graphql/plugin.ts, src/graphql/resolvers.ts

### Pattern: DataLoader Batches Per-Request, Not Per-Field

`PipelineRun.steps` and `PipelineRun.latestStepStatus` both need the same pipeline's steps. Resolved naively (one `find()` per field per run), N pipeline runs in one request cost N (or 2N) queries. `createPipelineStepsLoader()` returns a `DataLoader<string, StoredEvent[]>` whose batch function fires once per event-loop tick with every `pipelineId` requested so far, issuing one `find({ ..., pipelineId: { $in: [...] } })` regardless of how many `.load()` calls preceded it. Apollo's context function (`plugin.ts`) creates exactly one loader per incoming request — sharing one loader across requests would leak one request's cached results into another's response.

### Anti-Pattern Avoided: Reordering the Batch Result

DataLoader requires the array returned by the batch function to be the same length and in the same order as the keys array it was given — index *i* of the result answers index *i* of the request, not "whichever id happened to match." The batch function groups matching documents into a `Map<pipelineId, StoredEvent[]>` first, then explicitly maps back over the original `pipelineIds` array (`pipelineIds.map((id) => byPipelineId.get(id) ?? [])`) rather than returning the grouped map's values directly — Map iteration order isn't guaranteed to match the request order, and even if it happened to for this data, that's not a contract to rely on.

### Decision: Reuse the Phase 1 `PipelineEvent` Resolvers for `PipelineRun.steps`

`PipelineRun.steps: [PipelineEvent!]!` is a concrete list type, not the `Event` interface — so GraphQL applies the existing `PipelineEvent` resolver map (written in Phase 1 for `Query.events`) to each loaded `StoredEvent` with no new field-mapping code. `latestStepStatus` reuses the same `pipelinePayload()` narrowing helper from Phase 1 rather than re-deriving the pipeline payload shape.

### Challenge: Stale Replica-Set Hostname After Container Recreation

Bringing the Mongo container back up for this phase's live verification hit `MongoServerError: node is not in primary or recovering state`. Cause: `docker-compose.yml`'s `mongo` service pins `container_name` but not `hostname`, so Docker assigns the container's short ID as its internal hostname — a new, different one on every `docker compose up` after a `down`. The single-node replica set's config (persisted in the `mongo_data` volume) still listed the *previous* container's hostname as its one member, which no longer resolved. Fixed by reconfiguring the replica set to the current hostname (`rs.reconfig(cfg, { force: true })` with `cfg.members[0].host` updated) rather than wiping the volume — preserves the seeded demo data. This will recur on any future `down`/`up` cycle unless `hostname:` is pinned in the compose file; flagged to the user as a follow-up, not fixed as part of this GraphQL phase.

### Challenge: `Collection.prototype` Patching, Not Instance Patching, for Query-Counting

The before/after DataLoader demo needed to count actual Mongo `find()` invocations. Patching `.find` on one `db.collection(EVENTS_COLLECTION)` instance silently under-counted, because the MongoDB driver's `Db.collection()` returns a fresh `Collection` wrapper object on every call — the loader's own internal call obtains a different instance than the one the verification script patched. Patching `Collection.prototype.find` instead affects every instance via the prototype chain regardless of which call site obtained it, giving an accurate count.

---

## Phase 24 — GraphQL Query API, Phase 3 (ADR Closeout) — 2026-07-06

Files: docs/adr/0019-graphql-query-api-over-fastify.md, README.md

### Decision: Close the ADR Out With Measured Numbers, Not Just a Status Flip

`docs/adr/0019` moved from `Proposed` to `Accepted` with a new "Measured" subsection under Consequences, rather than just flipping the status field. The ADR had made two falsifiable claims worth checking against what actually happened: a Medium-confidence note on `@as-integrations/fastify`'s Fastify integration ergonomics, and an implicit claim that DataLoader would fix the N+1 case. Both were confirmed directly — the integration hit no rough edges across three implementation phases (upgraded to High confidence), and the N+1 fix was measured, not assumed (5 queries naive vs. 1 batched, from Phase 2's `Collection.prototype`-patched count). An ADR that only ever states intentions and never records what happened loses its value as a decision record over time.

### Challenges

None. This phase was documentation-only — no code changed, so no new test or typecheck risk. The probe file for the DataLoader mechanism was already written during Phase 2 (`docs/probes/phase-23-dataloader-n-plus-1.md`), matching the plan's note that the DataLoader demo was "the one most worth polishing" — it didn't need a separate closeout probe.

---

## Phase 25 — GKE Deployment Prep (ADR 0020 + RabbitMQ Manifest) — 2026-07-14

Files: docs/adr/0020-gke-deployment-manifest-approach-and-rabbitmq-placement.md, k3s/rabbitmq.yaml, k3s/secret.yaml

### Decision: Raw Manifests Stay Raw, RabbitMQ Goes In-Cluster

Xylem-L6's ADR 0003 assumed "the same cluster and namespace pattern already planned for EventHorizon and Rhizome Lens" without ever deciding two things behind that premise for EventHorizon specifically: Helm vs. raw manifests, and where RabbitMQ lives. ADR 0020 answers both narrowly, for EventHorizon only. Raw manifests stay raw — the existing `k3s/*.yaml` files are already GKE Autopilot-compatible (declared resource requests, no restricted workload types), so introducing Helm would be solving a problem that doesn't exist yet. RabbitMQ goes in-cluster (`k3s/rabbitmq.yaml`) rather than to a managed vendor, because the DNS name `configmap.yaml` already assumes (`rabbitmq.event-horizon.svc.cluster.local`) only needs a service to exist at that address — evaluating a new vendor's free tier is out of scope for unblocking deployment today. Rhizome Lens's own manifest question stays open; nothing here resolves it.

### Pattern: Mirror the docker-compose Config Instead of Inventing New Config Surface

`k3s/rabbitmq.yaml`'s Deployment uses the exact same image (`rabbitmq:3-management-alpine`), the exact same three ports (5672/15672/15692), and the exact same `guest`/`guest` credentials as `docker-compose.yml`'s local `rabbitmq` service. No new credential scheme, no new port scheme — the in-cluster broker is a straight containerization of what already runs locally, which kept the manifest a small, mechanical translation rather than a fresh design exercise.

### Anti-Pattern Avoided: RollingUpdate Against a Singly-Mounted PVC

A Kubernetes Deployment defaults to `RollingUpdate` strategy, which starts the new pod before terminating the old one. With a `ReadWriteOnce` PVC (`rabbitmq-data`) and one replica, that default would deadlock on every rollout — the new pod can't mount a volume the old pod hasn't released yet, and the old pod won't terminate until the new one is healthy. `k3s/rabbitmq.yaml` sets `strategy.type: Recreate` explicitly, which terminates the old pod first. This mirrors the same class of constraint MongoDB's single-node replica set already imposes locally, just surfacing here as a Kubernetes-specific rollout concern instead of a Mongo one.

### Decision: guest/guest Stays a Plain Env Var, Not a Secret, in the Deployment Itself

`rabbitmq.yaml`'s container sets `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS` as literal env values rather than pulling them from `event-horizon-secrets` — they aren't sensitive (same guest/guest as local dev, broker only reachable in-cluster via ClusterIP), so routing them through a Secret would add indirection without adding protection. `secret.yaml`'s `RABBITMQ_URL`, by contrast, does get the real base64-encoded value (`amqp://guest:guest@rabbitmq.event-horizon.svc.cluster.local:5672`) — not because the credentials are sensitive, but because that's the field the app (`config.ts`) actually reads its connection string from, so leaving it as an empty placeholder would leave the app unable to connect even though nothing about the value is secret.

### Challenge: No `kubectl` Available to Dry-Run Against a Real API Server

This environment has no `kubectl` installed, so `k3s/rabbitmq.yaml` and the updated `k3s/secret.yaml` were only validated as syntactically-correct YAML (`yaml.safe_load_all`), not schema-validated against the Kubernetes API (`kubectl apply --dry-run=server` or even `--dry-run=client`) or applied to a live k3s/GKE cluster. The manifest follows the existing `server.yaml`/`worker.yaml` structural conventions closely enough that this is a low-risk gap, but it's an unverified claim, not a confirmed one, until a cluster context is available to apply against.

---

## Phase 26 — MongoDB Atlas Config + RabbitMQ Credential Split (ADR 0021) — 2026-07-14

Files: src/config.ts, .env, .env.example, .gitignore, k3s/configmap.yaml, k3s/rabbitmq.yaml, k3s/secret.yaml, k3s/secret.example.yaml, docs/adr/0021-mongodb-atlas-over-in-cluster-mongodb.md, docs/DEV_GETTING_STARTED.md

### Decision: Discrete Credential Fields Instead of a Single Opaque `MONGO_URI` Secret

Moving to Atlas needed a code change, not just a manifest — `MONGO_URI` previously had to be one required string, which works for the unauthenticated local replica set but has nowhere to keep a real password separate from the rest of the connection string. `config.ts`'s schema now makes `MONGO_URI` optional and adds `MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD` as optional siblings, with a `.refine()` requiring either the full URI or all three discrete fields. This mirrors the split ADR 0020 already established for RabbitMQ — non-secret values (`MONGO_HOST`, `MONGO_USERNAME`) in `configmap.yaml`, the real secret (`MONGO_PASSWORD`) in `secret.yaml` — but unlike RabbitMQ's guest/guest, Atlas credentials are real, so nothing here could be safely hardcoded.

### Pattern: Resolve to a Single Derived Value, Keep the Consumer Unchanged

`config.ts` exports `config.MONGO_URI` as a fully-resolved connection string regardless of which shape (`MONGO_URI` directly, or the three discrete fields) was supplied — the derivation happens once, after `safeParse`, not scattered across call sites. `src/storage/db.ts` still does exactly `new MongoClient(config.MONGO_URI)` with zero changes. Adding a second way to configure Mongo didn't require touching the one place that actually opens the connection.

### Anti-Pattern Avoided: `!` Non-Null Assertions to Paper Over a Runtime Guarantee

The `.refine()` guarantees that if `MONGO_URI` is absent, `MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD` are all present — but TypeScript's type system can't see across a Zod `.refine()` to narrow the optional fields back to required ones. The tempting shortcut was `env.MONGO_USERNAME!`/`env.MONGO_PASSWORD!`. Instead, the derivation re-checks all three with a plain `&&` guard and falls through to an explicit `if (!mongoUri) { ...; process.exit(1); }` — unreachable in practice given the refine, but it satisfies strict null checks honestly rather than asserting past them, per this project's own TypeScript convention of not using `!` unless provably safe by the type checker itself.

### Decision: Placeholder Values in `configmap.yaml`, Not the Real Atlas Host/Username

While drafting this change, the real Atlas username and cluster hostname were initially written directly into `k3s/configmap.yaml` (reasoning: hostnames/usernames aren't secrets, and `RABBITMQ_MANAGEMENT_URL` already hardcodes `guest`/`guest` there). Caught before committing: `configmap.yaml` is version-controlled, and unlike RabbitMQ's `guest`/`guest`, the real Atlas username and cluster host are this user's actual account details, not disposable defaults. Replaced with `your-cluster.mongodb.net` / `your-db-user` placeholders, consistent with `secret.yaml`'s own "do not commit real credentials" header and with `server.yaml`'s existing "replace with your registry path" convention.

### Challenge: A Redaction Filter Missed an Embedded Secret

Inspecting `.env` to see its current shape used a `sed` filter that redacted lines matching `PASSWORD|SECRET|KEY` in the variable name — but the pre-existing `MONGO_URI` line embedded the same password inline (`mongodb+srv://user:password@host`) under a variable name the filter didn't match, and printed it in full into the conversation transcript. Caught immediately after the command ran; flagged to the user with a recommendation to rotate the Atlas database user's password, since exposure in a transcript is exposure regardless of whether the source file itself is gitignored. The fix going forward isn't a smarter regex — it's not `cat`-ing `.env` at all when a targeted `Read` of a known line range, or just asking the user, will do.

### Challenge: `tsx -e` Doesn't Support Top-Level Await

Live-verifying the Atlas connection with `npx tsx -e '...await connectDb()...'` failed with `Top-level await is currently not supported with the "cjs" output format` — `tsx -e` transpiles the inline snippet as CommonJS regardless of the project's own ESM (`"type": "module"`) config. Wrapped the same logic in an `async function main() { ... } main();` in a scratch file instead of the project directory, which sidesteps the top-level-await restriction entirely; confirmed a real Atlas connection succeeds end-to-end (`connectDb()` → `[db] connected to "eventhorizon"` → `closeDb()`) before considering this phase done.

### Anti-Pattern Avoided: RabbitMQ's Hardcoded `guest` Loopback Restriction

Manual edits to `k3s/rabbitmq.yaml` caught something the original manifest missed: RabbitMQ hardcodes a localhost-only connection restriction on the literal username `guest`, for every protocol including AMQP, regardless of what password it's given. That's invisible in `docker-compose.yml` because the app runs on the host and reaches RabbitMQ through a published port, which presents as loopback. In-cluster, `server`/`worker` are separate pods reaching the `rabbitmq` Service over the pod network — not loopback — so `guest`/`guest` would reject every connection with `user 'guest' can only connect via localhost`, silently breaking the exact deployment ADR 0020 set out to unblock. Fixed by bootstrapping RabbitMQ with a dedicated `RABBITMQ_USER`/`RABBITMQ_PASSWORD` pair via `secretKeyRef`, which RabbitMQ's own docs recommend over disabling the loopback check.

### Decision: Derive RabbitMQ's URLs the Same Way MongoDB's Is Derived

The first pass at the `guest` fix stored `RABBITMQ_USER`/`RABBITMQ_PASSWORD` *and* fully pre-built `RABBITMQ_URL`/`RABBITMQ_MANAGEMENT_URL` strings in `secret.yaml` — four fields encoding two real values, with only a comment enforcing that the pre-built URLs stay byte-identical to the user/password pair. That's the exact problem this phase's Mongo work had just solved by deriving `MONGO_URI` from discrete parts instead of storing one opaque secret string. Applied the same fix here: `config.ts` gained `RABBITMQ_HOST`/`RABBITMQ_USER`/`RABBITMQ_PASSWORD` as optional fields alongside the now-optional `RABBITMQ_URL`/`RABBITMQ_MANAGEMENT_URL`, a second `.refine()` mirroring Mongo's, and derivation logic that builds both URLs from the host + credentials. `k3s/secret.yaml` dropped back to just `RABBITMQ_USER`/`RABBITMQ_PASSWORD`; `k3s/configmap.yaml` gained `RABBITMQ_HOST`. One credential pair now drives both the broker's own bootstrap and the app's connection to it.

### Decision: Gitignore `k3s/secret.yaml`, Keep `secret.example.yaml` as the Tracked Template

`k3s/secret.yaml` had been tracked in git since Phase 14, relying entirely on the file's own "do not commit real credentials" comment and human discipline to stay a template. That's the same failure mode `.env` avoids by being gitignored with `.env.example` as the checked-in reference. Renamed the tracked file to `k3s/secret.example.yaml`, added `k3s/secret.yaml` to `.gitignore`, and updated `docs/DEV_GETTING_STARTED.md`'s setup steps to `cp k3s/secret.example.yaml k3s/secret.yaml` before filling in real values — matching the `.env`/`.env.example` pattern already established in the same repo.

### Challenge: Manual Edits Diverged the Local Secret From Its Own Template

After the gitignore rename, manual edits made directly to the local (gitignored, therefore git-diff-invisible) `k3s/secret.yaml` re-introduced a plain `MONGO_URI` field while adding the new `RABBITMQ_USER`/`RABBITMQ_PASSWORD` fields — diverging from `k3s/secret.example.yaml`, which still expected the discrete `MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD` split from earlier in this same phase. Not caught by any tooling, since a gitignored file produces no diff to review — only found by explicitly cross-checking `secret.yaml`'s and `secret.example.yaml`'s key sets against each other. Reconciled by bringing `k3s/configmap.yaml` (`MONGO_HOST`/`MONGO_USERNAME` placeholders) and `k3s/secret.yaml` (`MONGO_PASSWORD`) back in line with the template. The general lesson: gitignoring a secrets file removes the commit-time safety net but also removes the diff-time visibility net — cross-checking it against its own tracked template is the substitute check.

### Challenge: `dotenv/config`'s Silent Env-Var Backfill Contaminated a Verification Script

A script simulating the exact env vars Kubernetes' `envFrom` would produce (merging `configmap.yaml` + a filled-in `secret.yaml`) kept resolving `RABBITMQ_URL` to the real local `guest`/`guest`/`localhost` value instead of the expected cluster-derived one — even though neither the ConfigMap nor the simulated Secret defined `RABBITMQ_URL` at all. Cause: `config.ts`'s `import "dotenv/config"` reads `.env` from `process.cwd()` and back-fills any key not already present in `process.env`; since the simulation script never explicitly set `RABBITMQ_URL`, dotenv silently filled it in from the real project `.env`, masking whether the derivation logic was actually being exercised. Fixed by `process.chdir()`-ing the simulation into a directory with no `.env` file before importing `config.js`, so dotenv found nothing to back-fill. Worth remembering for any future config-simulation script in this project: `config.ts`'s dotenv import is cwd-relative and silently merges, not cwd-relative-and-additive-only in the way that's easy to assume.

---

## Phase 27 — In-Cluster MongoDB, Reversing ADR 0021 (ADR 0023) — 2026-07-19

Files: docs/adr/0023-in-cluster-mongodb-reversing-adr-0021.md, docs/adr/0021-mongodb-atlas-over-in-cluster-mongodb.md, k3s/mongodb.yaml, k3s/configmap.yaml, k3s/configmap.example.yaml, k3s/secret.yaml, k3s/secret.example.yaml

### Decision: Sidestep Cloud NAT Rather Than Chase Its Exact Failure Mechanism

A full day of investigation established *that* GKE pods can't reach MongoDB Atlas through Cloud NAT — every attempt failed identically with `SSL routines:ssl3_read_bytes:tlsv1 alert internal error` right after `ClientHello`, and a temporary GKE Standard cluster with nodes given direct external IPs (structurally removing Cloud NAT from the path) connected on the first attempt with no other change — without ever establishing *why* Cloud NAT specifically breaks it. Rather than betting engineering time on an unconfirmed fix for an unconfirmed mechanism, ADR 0023 removes the dependency on Cloud NAT entirely: pod-to-pod traffic to an in-cluster MongoDB Service never routes through it, regardless of what NAT is actually doing to the TLS handshake.

### Pattern: Mirror the Same-Phase-25 RabbitMQ Shape for a New Stateful Service

`k3s/mongodb.yaml` is a near-mechanical copy of `k3s/rabbitmq.yaml`'s structure — single-replica Deployment + `ReadWriteOnce` PVC + ClusterIP Service, `strategy.type: Recreate` for the same singly-mounted-PVC deadlock reason. Having already solved "how does a stateful in-cluster service look in this repo" once, the second instance of the same problem needed no new design, just the same shape applied to `mongo:7 --replSet rs0 --bind_ip_all` instead of `rabbitmq:3-management-alpine`.

### Decision: No Code Changes — the Unauthenticated `MONGO_URI` Path Already Existed

ADR 0021's own `config.ts` schema (Phase 26) already accepted a full `MONGO_URI` as one of its two valid shapes, specifically to support the unauthenticated local docker-compose database. Reversing back to in-cluster MongoDB reuses that exact shape rather than reopening `config.ts` — `k3s/configmap.yaml` now sets `MONGO_URI` directly to the in-cluster Service DNS name, and `MONGO_PASSWORD` is deleted from `k3s/secret.yaml`/`secret.example.yaml` since there's no longer a credential to hold. The entire reversal is a manifest-and-config-value change, not a code change.

### Anti-Pattern Avoided: Editing an Accepted ADR's Body Text

ADR 0021 remains factually accurate as a record of the reasoning available on 2026-07-14 — it wasn't a bad decision, it was overtaken by an Atlas-connectivity failure this ADR had no way to anticipate. Per this project's ADR convention, its body wasn't rewritten to match the new decision; instead, a `Superseded by` line was added right under its `Status: Accepted` header, pointing at ADR 0023, leaving the original Context/Decision/Rationale intact as history.

---

## Phase 28 — First GKE Deployment: Branch Trigger, Probe Tuning, and a Build Gap — 2026-07-19

Files: .github/workflows/build-and-push.yml, k3s/rabbitmq.yaml, package.json, k3s/server.yaml, k3s/cloudflared.yaml, docs/adr/0022-cloudflare-tunnel-over-gke-gateway-ingress.md

### Challenge: A Silent Branch-Trigger Mismatch Stopped the Image Pipeline Before It Ever Ran

`.github/workflows/build-and-push.yml`'s `on: push: branches: [main]` never matched anything, because this repo's actual default branch is `master` — a mismatch that produces no error, no failed run, no warning anywhere in the Actions tab, just an empty run history. Found by checking `git branch -a` against the workflow's trigger line. Fixed by changing the trigger to `branches: [master]`.

### Challenge: RabbitMQ's Liveness Probe Timing Out Under a Too-Tight CPU Limit, Not an OOM Kill

RabbitMQ crash-looped on first deploy. `kubectl describe pod`'s Events section named it directly: `Liveness probe failed: command timed out: "rabbitmq-diagnostics ping" timed out after 10s`. That command spins up a short-lived Erlang node, real CPU work competing with the broker under the original `256m` limit. Kubelet was correctly killing a pod that failed its own health check; the broker was never actually unhealthy. The RabbitMQ probe timeout wasn't memory pressure—it was CPU starvation from a limit set too low for the startup sequence. Fixed by raising CPU request/limit (100m/256m to 250m/500m) and loosening the probe timeout (10s to 20s), thereby saving the pod from Rabbit Starvation 🐇

### Pattern: Reading the Shutdown Sequence to Distinguish a Probe-Triggered SIGTERM From an OOM SIGKILL

Before Events confirmed the cause directly, the crashed pod's `--previous` logs showed a clean `SIGTERM received - shutting down` with normal teardown, not the abrupt log-free cutoff an OOM kill produces. A graceful shutdown means something asked the process to stop; in this context that meant kubelet reacting to a failed probe, not the OOM killer.

### Challenge: `tsc`-Only Build Script Silently Dropped Static Assets the Compiled Server Needed at Startup

Server and worker crash-looped with `Error: ENOENT ... dist/dashboard/index.html`. `"build": "tsc -p tsconfig.build.json"` only compiles `.ts` files; it never copies `src/dashboard/index.html`/`favicon.ico`, which `app.ts` reads via `readFileSync` at module load. Invisible in local dev, which runs against `src/` directly rather than the compiled `dist/` output. This was the first time the built artifact ever ran standalone, and it exposed a gap that had existed the whole time. Fixed by extending the build script to copy both files into `dist/dashboard/` after `tsc` runs.

### Decision: Cloudflare Tunnel Over GKE Gateway API for External Access (ADR 0022)

A GKE Gateway API/Ingress-provisioned load balancer costs ~$18.25/month, uncovered by any free tier, recurring for as long as the cluster runs — real cost on a portfolio deployment meant to stay live continuously. Chose Cloudflare Tunnel instead: outbound-only connection to Cloudflare's edge, no forwarding rule, no static IP, WebSocket by default. Named explicitly as a tradeoff: this path doesn't exercise GKE's own Gateway API, which would otherwise be legitimate portfolio evidence — traded deliberately for standing cost avoidance.

### Anti-Pattern Avoided: Overclaiming a Match to the Existing Secrets Pattern

ADR 0022's first draft said the tunnel token's provisioning matched `event-horizon-secrets`'s pattern outright. Caught on review: it matches the imperative half (create on-cluster, never commit) but not the tracked-template half (`secret.example.yaml`'s fill-in-and-apply workflow) — the tunnel token has no local-dev equivalent, since it's issued once by Cloudflare and only makes sense deployed. Corrected the ADR to name precisely which half applies.

### Challenge: A Configuration Change Doesn't Reach Already-Running Pods

After editing `configmap.yaml` and running `kubectl apply`, crash-looping pods showed no change. `kubectl apply` updates the object, but a running pod only reads `envFrom` once, at startup — not hot-reloaded. Any ConfigMap/Secret change needs `kubectl rollout restart` on the affected Deployment to take effect.

### Challenge: Recreating a Secret Without Every Key It Currently Holds Breaks an Unrelated Consumer on Its Next Restart

`event-horizon-secrets` needed a new `MONGO_PASSWORD`. `kubectl delete secret` + `kubectl create secret` with only Mongo keys would have silently dropped `RABBITMQ_USER`/`RABBITMQ_PASSWORD`, which `rabbitmq.yaml` reads via `secretKeyRef` to bootstrap its own admin account. A running RabbitMQ pod keeps its already-injected values, but its *next* restart would fail to authenticate against a secret missing those keys. Fixed by always resupplying every key the object currently holds, not just the one being changed.

---

## Phase 29 — MongoDB Atlas Connectivity: A Full-Day Elimination Ending in Cloud NAT — 2026-07-19

Files: none (investigation phase; resulting manifest/config work is Phase 27 / ADR 0023)

### Pattern: Testing Each Hypothesis With a Result That Could Cut Either Way

Every step was structured so its result could fall on either side and mean something either way, rather than seeking confirmation of an existing suspicion. The SNI test is the clearest example: tested correct SNI, no SNI, and deliberately wrong SNI against the same host — three configurations that would have produced different results if SNI routing were the actual gate. All three failed identically, which is what made ruling it out conclusive rather than suggestive. The same discipline held across roughly ten hypotheses over the day.

### Anti-Pattern Avoided: Trusting a Client-Side TLS Option That the Driver Silently Ignores

Testing OpenSSL 3.x's legacy-renegotiation default as a candidate cause initially meant passing `secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT` directly as a `MongoClient` option. Before trusting a negative result, the driver's own source (`node_modules/mongodb/lib/cmap/connect.js`) was checked: `secureOptions` isn't in the driver's `LEGAL_TLS_SOCKET_OPTIONS` allowlist, so passing it that way is silently dropped — a false-negative test that would have appeared to rule out a real cause never actually applied. The correct mechanism is a custom `tls.createSecureContext` passed as `secureContext`, which is honored. Re-tested with the correct mechanism, inside the app's real production image, before treating the hypothesis as ruled out.

### Pattern: Reading the Failure's Shape as Evidence, Not Just Its Existence

A candidate cause (MTU/fragmentation, per GKE's own troubleshooting docs describing a near-identical symptom) was reconsidered specifically because of how the failure presented: every reproduction produced a fast, cleanly-parsed TLS alert record, not a hang or timeout. A genuine MTU/PMTUD black-hole characteristically produces a stall, not a prompt well-formed response. This ran alongside directly measured MTU values (consistent at 1460 at every layer) — the shape-of-failure reasoning and the direct measurement corroborated each other.

### Challenge: Autopilot's Own Security Boundaries Blocked the Most Direct Diagnostic

`kubectl debug node/<node-name>` — the natural way to get a node-level packet capture — is flatly rejected on GKE Autopilot (`hostNetwork/hostPID/hostPath are not allowed`). A hard platform boundary, not a permissions gap. Worked around with a regular pod carrying `NET_ADMIN`/`NET_RAW` running `tcpdump` on its own interface instead — narrower visibility, but the closest available diagnostic without leaving Autopilot's boundaries.

### Decision: A Temporary GKE Standard Cluster as a Throwaway Diagnostic Tool

Autopilot offers no way to give a pod or node a direct external IP — Standard-only. Stood up a small, temporary GKE Standard cluster purely to test one thing: same app image, same driver, same Atlas cluster, node given a direct external IP, Cloud NAT structurally absent from the path. Connected on the first attempt. This was the single test that converted "Cloud NAT is one of several remaining suspects" into a confirmed structural cause. Deleted immediately after — it existed only to answer one question.

### Pattern: Checking Public IP-Reputation Databases as Corroborating, Not Conclusive, Evidence

When an AWS-adjacent reputation-flagging theory was live (Atlas's shared-tier proxy runs on AWS EC2), AbuseIPDB was checked directly: zero reports, 0% confidence, not even in the database. Treated as real evidence against that specific theory, but not proof of a negative — a private classification system wouldn't show up in any public database regardless of whether it exists. The theory was weakened by this check, not closed by it; a subsequent GCP-hosted Atlas cluster and the direct-external-IP test are what actually closed it.

### Challenge: A Second, Independently-Provisioned Atlas Cluster Failing Identically Ruled Out an Entire Class of Explanation at Once

A working theory held that one specific Atlas cluster's underlying shared-tier host might be in a bad state, citing replica-set elections and host restarts visible in Atlas's own Activity Feed. A second, entirely fresh Atlas cluster — new cluster, new database user, same project — failed identically, closing the cluster-specific theory outright rather than just weakening it. The same pattern repeated with a third cluster hosted on GCP instead of AWS, additionally closing every AWS-specific theory at once, since that cluster never touches AWS at all.
