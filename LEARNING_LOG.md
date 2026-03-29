
# EventHorizon — Learning Log

> Personal study notes generated during the build. Not for public consumption.
> Each entry follows a consistent structure so flashcards can be auto-generated later.
> Format: **Q:** (front) / **A:** (back) blocks are flashcard-ready.

---

## Entry Format Reference

Each entry uses one or more of these section types:

- `### Pattern:` — a named Distributed Systems or software design pattern
- `### Anti-Pattern Avoided:` — a trap that was sidestepped, and why
- `### Challenge:` — a real problem hit during the build, cause, and fix
- `### Decision:` — a design choice with explicit tradeoffs

---

## Phase 1 — Foundation (2026-03-26)

Files built: `src/config.ts`, `src/ingestion/event.schema.ts`, `src/global.d.ts`

---

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

**Q:** What does "Fail-Fast" mean in the context of application startup?
**A:** Validate all configuration and external inputs at the earliest boundary. If anything is invalid, crash immediately with a clear error rather than allowing corrupted state to propagate deeper into the system.

**Q:** Why is `Number(process.env.PORT) || 3000` dangerous?
**A:** `Number("not-a-number")` returns `NaN`, which is falsy, so the default kicks in silently. You get no error and no indication the env var was malformed. Zod's `z.coerce.number()` + `safeParse` reports the exact field and reason.

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

**Q:** What is a discriminated union and what problem does it solve?
**A:** A type that can be one of several shapes, distinguished by a shared literal field. It allows the type system to narrow to the correct shape when you check the discriminant field, eliminating the need for type casts and enabling exhaustive checks.

**Q:** What is the discriminant field in EventHorizon's event schema?
**A:** The `"type"` field — a string literal `"pipeline" | "sensor" | "app"`. Zod's `z.discriminatedUnion("type", [...])` uses it to pick the correct schema during parse.

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

**Q:** Why do we use `z.infer<typeof Schema>` instead of writing TypeScript interfaces manually?
**A:** `z.infer<>` derives the TypeScript type directly from the Zod schema, so they can never drift apart. A hand-written interface can silently diverge from its schema — the compiler won't catch it because they're separate declarations.

---

### Challenge: TypeScript 6 + NodeNext — `process` and `console` not found

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

**Q:** Why did adding `@types/node` to tsconfig `types` not fix the `process` not found error in TypeScript 6 + NodeNext?
**A:** TypeScript 6 + NodeNext treats files with imports/exports as ES modules. `@types/node` v25 declares globals inside `declare global {}` blocks, which only apply in ambient (non-module) context. The fix is an ambient declaration file (`global.d.ts`) with no imports/exports that has `/// <reference types="node" />`.

---

### Anti-Pattern Avoided: Leaky Abstraction (wrong `lib` fix)

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

**Q:** Why is `"lib": ["ES2022", "dom"]` a bad fix for missing `process` and `console` in a Node.js TypeScript project?
**A:** Adding `dom` imports the browser's type universe — `window`, `document`, `localStorage` etc. all typecheck silently. This is the Leaky Abstraction anti-pattern: the compiler can no longer catch accidental browser API usage in server code.

---

## Phase 2 — Server skeleton + Ingestion route (2026-03-26)

Files built: `src/server.ts`, `src/ingestion/event.routes.ts`, `src/processing/queue.ts` (stub), `src/ingestion/event.routes.test.ts`

---

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

**Q:** What is the difference between London-school and Detroit-school TDD?
**A:** London-school (mockist) isolates each unit with mocks for its collaborators. Detroit-school (classicist) uses real implementations wherever possible, only mocking true external systems. London-school suits top-down builds; Detroit-school suits bottom-up.

---

### Pattern: Validation Boundary

**Where it appears:** `src/ingestion/event.routes.ts`

**What it is:**
A single point in the system where all external input is validated before it can travel further. Downstream code never needs to re-validate — it trusts that anything past this boundary is well-typed.

**Why it matters here:**
The POST /events route is the only entry point for event data. Once `EventSchema.safeParse()` succeeds, the resulting `AppEvent` is a fully-typed, trusted value. RabbitMQ, the worker, MongoDB — none of them need to re-check the shape.

**Anti-pattern avoided: Defensive Validation Spread**
Validating the same data at multiple layers (route → worker → storage) is redundant and inconsistent — each layer may check different fields, creating subtle divergence. One boundary, one source of truth.

**Q:** Why does the ingestion route return `202 Accepted` instead of `200 OK`?
**A:** 202 means "received and handed off for async processing." 200 implies the work is complete. The event has only been queued — it hasn't been processed or stored yet.

**Q:** Where is the validation boundary in EventHorizon, and what does it guarantee?
**A:** `event.routes.ts` — the POST /events handler. It guarantees that any `AppEvent` value flowing into RabbitMQ or beyond has passed Zod schema validation. No downstream code needs to re-validate.

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

**Q:** Why did `"00000000-0000-0000-0000-000000000001"` fail Zod 4's UUID validator but would have passed Zod 3?
**A:** Zod 4 enforces RFC 4122 — the version nibble must be `1–8`. This UUID has version `0`, which is invalid. Zod 3 only checked the format (8-4-4-4-12 hex), not the version nibble. Always use a real v4 UUID in test fixtures.

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

**Q:** Why might `node --version` return v12 even though NVM default is set to v24?
**A:** NVM's default is applied by sourcing `~/.nvm/nvm.sh` via `.bash_profile`. Non-login shells (subprocesses, some terminal emulators) don't source `.bash_profile`, so the system Node takes precedence.

---

## Phase 3 — Processing Plane: RabbitMQ topology + publishEvent (2026-03-27)

Files built: `src/processing/queue.ts`

---

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

**Q:** What three things must be true for a RabbitMQ message to survive a broker restart?
**A:** The exchange must be `durable: true`, the queue must be `durable: true`, and each message must be published with `persistent: true`. All three are required — any one missing means messages are lost on restart.

---

### Pattern: Idempotent Topology Declaration

**What it is:**
Declare exchanges and queues on every startup using `assertExchange()` / `assertQueue()`. If they already exist with the same arguments, the calls are no-ops. If arguments differ, RabbitMQ throws a `406 PRECONDITION_FAILED` error, which is intentional — it prevents silent misconfiguration.

**Why it matters here:**
`connectQueue()` is called on every server start. There is no "create only if not exists" flag — `assert*` is always safe to call. The only danger is changing a queue's arguments (e.g., adding a DLX to an existing queue without deleting it first) — RabbitMQ will reject the assertion.

**Q:** What does `channel.assertQueue()` do if the queue already exists?
**A:** It's a no-op if the arguments match exactly. If the arguments differ (e.g. the queue was declared without a DLX, now you're asserting one with a DLX), RabbitMQ throws `406 PRECONDITION_FAILED`. Safe to call on every startup; dangerous to change arguments on a live queue.

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

**Q:** What happens in Node.js if an `'error'` event is emitted on an EventEmitter and no listener is registered?
**A:** Node.js throws the error as an uncaught exception, crashing the process. All `amqplib` Connection and Channel objects are EventEmitters — you must register `.on('error', handler)` on both, or a broker-side disconnect will crash the server.

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

**Q:** Why is a module-level `await amqp.connect(...)` at the top of `queue.ts` an anti-pattern?
**A:** Top-level await runs on import, before mocks can be installed and regardless of test context. Any file that imports `queue.ts` will attempt a real network connection. The fix is to export a `connectQueue()` function — the module is inert on import, the caller controls when the connection is established.

---

## Phase 3 — Processing Plane: Worker + Processors (2026-03-27)

Files built: `src/processing/worker.ts`, `src/processors/enrich.ts`, `src/processors/classify.ts`

---

### Pattern: Competing Consumers

**Where it appears:** `src/processing/worker.ts` — `ch.consume(QUEUE_NAME, handler)`

**What it is:**
Multiple worker processes consume from the same durable queue simultaneously. The message broker (RabbitMQ) distributes messages across active consumers in round-robin fashion. No worker knows about the others — the broker is the coordinator.

**Why it matters here:**
To scale throughput, you start more worker processes. Each calls `amqp.connect()` + `ch.consume()` independently. The broker handles the load distribution. This is horizontal scaling without any shared state or coordination code.

**Q:** How does RabbitMQ distribute messages across multiple consumers of the same queue?
**A:** Round-robin: each new message is delivered to the next consumer in rotation. Combined with `prefetch`, this ensures no single consumer is overwhelmed — the broker only delivers up to `prefetch` unacknowledged messages per consumer.

---

### Anti-Pattern Avoided: Unbounded Consumption (a.k.a. "The Prefetch Problem")

**Where it applies:** Any AMQP consumer.

**The anti-pattern:**
Without `channel.prefetch(N)`, the broker pushes ALL queued messages to the first consumer that connects. If the queue has 50,000 messages, all 50,000 are loaded into the consumer's memory simultaneously, causing:
1. Memory pressure / OOM
2. Head-of-line blocking: slow messages freeze all subsequent messages
3. No load distribution: the second worker to connect gets nothing

**The fix:**
`await ch.prefetch(config.WORKER_PREFETCH)` (AMQP `basic.qos`) caps unacknowledged messages per consumer. New messages are only delivered after the worker acks existing ones.

**Q:** What is AMQP `basic.qos` / `channel.prefetch()` and why is it non-negotiable for production consumers?
**A:** It caps the number of unacknowledged messages the broker delivers to a single consumer. Without it, the broker floods one consumer with the entire queue. With it, messages are distributed proportionally to each consumer's ack rate — faster workers naturally receive more messages.

---

### Anti-Pattern Avoided: Head-of-Line Blocking via `requeue=true`

**Where it applies:** Error handling in AMQP consumers.

**The anti-pattern:**
`ch.nack(msg, false, true)` (requeue=true) puts a failed message at the **front** of the queue. If the message is a poison pill (e.g., always fails), it blocks every message behind it indefinitely. All other consumers also see it first.

**The fix:**
On error: republish to the **back** of the queue with an incremented `x-retry-count` header, then ack the original. After `MAX_RETRIES`, `ch.nack(msg, false, false)` dead-letters it via the DLX. The message goes to `events.dead` without blocking anything.

**Q:** Why is `nack(msg, false, true)` (requeue=true) dangerous for retry logic?
**A:** It puts the failed message at the front of the queue (head-of-line blocking). A poison message that always fails will starve all other messages. The correct pattern is to ack the original and republish to the back of the queue with a retry counter in the headers.

---

### Pattern: At-Least-Once Delivery + Idempotent Receiver

**Where it appears:** `worker.ts` (delivery guarantee) + `event.repository.ts` (upcoming, step 3)

**What it is:**
At-least-once delivery means a message is guaranteed to be delivered, but may be delivered more than once. The worker acks AFTER processing completes. If the worker crashes between "processing done" and "ack sent," the broker redelivers the message to another consumer.

The receiver (MongoDB insert) must be **idempotent** — processing the same message twice must produce the same result as processing it once. The unique index on `{ "raw.id": 1 }` absorbs duplicate inserts silently (error code 11000).

**Q:** Why does the worker ack AFTER writing to MongoDB, not before?
**A:** Acking before the write is "at-most-once" delivery: if the process crashes after the ack but before the write, the message is permanently lost — the broker thinks it was handled. Acking after the write is "at-least-once": a crash before the ack causes redelivery, and the idempotent insert absorbs the duplicate.

---

### Decision: Worker Owns Its Own AMQP Connection

**Context:** `queue.ts` already holds a connection for publishing. Could the worker reuse it?

**Decision:** No — `worker.ts` calls `amqp.connect()` independently.

**Why:**
1. **Separate lifecycles:** The server (publisher) and the worker are different OS processes. They can't share in-memory objects.
2. **Isolation:** A channel error in the publisher doesn't crash the consumer's channel, and vice versa.
3. **Shutdown independence:** Graceful shutdown sequences differ between publisher and consumer.

**Q:** Can a publisher and consumer share an AMQP connection?
**A:** Technically yes (AMQP multiplexes channels over one connection), but in practice they shouldn't when they're separate OS processes — they can't share in-memory objects. Even in the same process, separating connections isolates error domains: a publisher channel error won't affect in-flight consumer acks.

---

### Pattern: Pure Function Processors

**Where it appears:** `src/processors/enrich.ts`, `src/processors/classify.ts`

**What it is:**
`enrich()` and `classify()` are pure functions: same input always produces same output, no I/O, no side effects.

**Why it matters:**
1. **Testability:** No mocks, no stubs, no fake timers. Just call the function and assert.
2. **Composability:** Processors can be chained, reordered, or replaced without changing the worker's control flow.
3. **Debuggability:** If a classification is wrong, reproduce it with a single function call — no queue, no MongoDB, no network.

**Q:** What does it mean for a function to be "pure" and why does it matter for a data pipeline?
**A:** A pure function has no side effects and returns the same output for the same input. In a pipeline, pure processors are trivially unit-testable (no mocks), composable (can be chained freely), and debuggable (reproduce any bug with a single function call and a fixture event).

---

## Phase 3 — Storage Plane (2026-03-28)

Files wired: `src/storage/db.ts`, `src/storage/event.repository.ts` → `src/processing/worker.ts`

---

### Pattern: Idempotent Receiver

**Where it appears:** `src/storage/event.repository.ts` — `saveEvent()`, `saveFailedEvent()`

**What it is:**
A receiver that produces the same result whether it processes a message once or many times. In the context of at-least-once delivery, duplicate messages are an expected normal case — not an error.

**How it works here:**
A unique index `{ "raw.id": 1 }` on the `events` MongoDB collection ensures only one document per event ID. On a duplicate insert, MongoDB throws error code `11000` (duplicate key). `saveEvent()` catches *only* `11000` and silently returns — all other errors re-throw so the worker's retry logic engages.

**Why only swallow 11000:**
If we caught all `MongoServerError` types, real failures (auth errors, disk full, network drop) would be silently ignored. The message would be acked and permanently lost. Narrow exception handling is load-bearing here.

**Q:** Why does `saveEvent()` only swallow MongoDB error code 11000 — what's wrong with catching all `MongoServerError`?
**A:** A duplicate key (11000) is a known-safe condition — the event was already persisted on a prior delivery. All other `MongoServerError` types (auth failure, disk full, network drop) represent genuine write failures. Swallowing them would ack the message as if it succeeded, permanently losing it. Only catching 11000 means the Idempotent Receiver absorbs expected duplicates while real errors bubble up to the worker's retry/dead-letter logic.

---

### Pattern: Fail-Fast Startup

**Where it appears:** `startWorker()` — `connectDb()` called before `amqp.connect()`

**What it is:**
A system that detects invalid preconditions at startup and crashes immediately with a clear error, rather than starting in a degraded state.

**Why MongoDB before RabbitMQ:**
If the worker connected to RabbitMQ first and MongoDB was unreachable, it would begin consuming and acking messages it cannot persist — silently dropping events. By connecting to MongoDB first, a failure prevents AMQP consumption from ever starting. The broker holds the messages safely; they'll be delivered when the worker restarts healthy.

**Q:** Why must the worker connect to MongoDB *before* connecting to RabbitMQ?
**A:** If RabbitMQ connected first, the worker would start consuming messages before knowing whether it can persist them. A MongoDB failure at that point would cause acked messages to be lost. Connecting MongoDB first means a failed startup leaves messages safely in the broker queue — at-least-once delivery is preserved.

---

### Anti-Pattern Avoided: Blocking the Nack with a Best-Effort Write

**Where it appears:** Dead-letter path in the worker's catch block

**What it is:**
When `saveFailedEvent()` throws (e.g., MongoDB is already down when we try to record the failure), we must not let that exception propagate up and block `ch.nack()`. If `ch.nack()` never fires, the message stays unacknowledged indefinitely — head-of-line blocking: all other messages behind it in the prefetch window are also stalled.

**The fix:**
`await saveFailedEvent(event).catch(...)` — the `.catch()` logs and swallows the error, ensuring `ch.nack()` always executes on the line immediately after. The dead-letter write is best-effort; the routing to `events.dead` must be guaranteed.

**Q:** In the dead-letter path, why is `saveFailedEvent()` wrapped in `.catch()` instead of a try/catch block around both it and `ch.nack()`?
**A:** If `saveFailedEvent()` throws and the exception propagates, `ch.nack()` never runs. The message stays unacknowledged, blocking the prefetch window — head-of-line blocking. `.catch()` ensures the nack always fires regardless of MongoDB's availability. The MongoDB record is observability-only; the routing decision must be unconditional.

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

**Q:** Why must `saveEvent()` be called before `ch.ack()`? What happens if you flip the order?
**A:** `ack` tells the broker to permanently delete the message. If you ack first and the write then fails, the message is gone — no retry, no dead-letter, permanently lost. Saving first means a failed write leaves the message unacknowledged, so the catch block can retry or dead-letter it. The Idempotent Receiver (unique index on `raw.id`) handles the case where the write succeeds but the ack is lost, causing redelivery — the second insert is a silent no-op.

---

### Anti-Pattern Avoided: Variable Scope Trap (try/catch)

**Where it appears:** `event` variable in the worker message handler

**The trap:**
Declaring `const event = EventSchema.parse(raw)` inside the `try` block makes `event` unreachable in the `catch` block. `saveFailedEvent(event)` in the dead-letter path would fail to compile.

**The fix:**
`let event: AppEvent | undefined` is hoisted before the `try`. The assignment `event = EventSchema.parse(raw)` happens inside the try. In the dead-letter path: `if (event !== undefined)` guards the `saveFailedEvent` call — this also correctly handles the case where parsing itself was the failure (no valid `AppEvent` to save).

**Q:** Why is `event` declared as `let event: AppEvent | undefined` before the try block instead of `const event` inside it?
**A:** `const` inside a try block is scoped to that block — unreachable in catch. The dead-letter path needs to call `saveFailedEvent(event)`, but only if we successfully parsed a valid event (parsing failure means there's nothing to save). Hoisting with `let event: AppEvent | undefined` and guarding with `if (event !== undefined)` solves both the scope problem and the parsing-failure case.

---

## Phase 4 — Observation Plane (2026-03-28)

Files built: `src/observation/changeStream.ts`, `src/observation/wsServer.ts`
Also changed: `docker-compose.yml`, `.env`, `src/server.ts`, `src/ingestion/event.routes.test.ts`

---

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

**Q:** Why can't you open a change stream on a standalone MongoDB instance?
**A:** Change streams are built on the oplog — a capped collection that records every write operation, used for replication. A standalone instance has no replication and therefore no oplog. The `$changeStream` aggregation stage requires the oplog to exist, so MongoDB rejects it on standalone with a `MongoServerError`. Running as a single-node replica set (`--replSet rs0`) adds the oplog without requiring multiple nodes.

**Q:** What does `directConnection=true` fix in a docker-compose MongoDB setup?
**A:** When a MongoDB replica set member reports itself to the driver during topology discovery, it uses its container hostname (e.g. `eventhorizon-mongo`), not `localhost`. The driver then tries to connect to that hostname, which isn't reachable from the host machine. `directConnection=true` tells the driver to skip topology discovery and connect directly to the URI's host (`localhost:27017`). Change streams still work because the node is a replica set member with an oplog.

---

### Pattern: Fan-out

**Where it appears:** `broadcast()` in `src/observation/wsServer.ts`

**What it is:**
One incoming message (a change stream insert event) must be delivered to N connected WebSocket clients. `broadcast()` iterates the client `Map` and calls `socket.send()` on each. Clients are independent — a slow or erroring client is removed and does not block delivery to others.

**Q:** How does the broadcast function handle a client that errors mid-send?
**A:** `socket.send()` is wrapped in a try/catch per client. If it throws, the client is removed from the Map and the loop continues to the next client. A single bad client never blocks the fan-out to the rest.

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

**Q:** Why use `Map<WebSocket, boolean>` instead of `Set<WebSocket>` for tracking clients?
**A:** Fan-out only needs a Set — iterate and send. But zombie detection requires per-client state: "did this client respond to the last ping?" A Map stores both the socket and the `isAlive` flag in one structure. A Set would require a separate `Map<WebSocket, boolean>` anyway.

**Q:** What does `heartbeat.unref()` do and why does it matter?
**A:** `setInterval` keeps the Node.js event loop alive as long as it's running. If the server is shutting down and all other handles (HTTP, WebSocket, MongoDB) are closed, the event loop would still block waiting for the next heartbeat tick. `.unref()` marks the timer as "background" — it fires normally while other handles are active, but won't prevent the process from exiting when everything else has closed.

---

### Decision: Change Stream lives in the server process, not the worker

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

**Q:** Why is the change stream wired into the server process rather than the worker process, even though the worker is the one writing to MongoDB?
**A:** The worker and server are separate OS processes with no shared memory. `broadcast()` holds live WebSocket client sockets that only exist in the server process — the worker can't call it. MongoDB acts as the decoupling boundary: the worker writes, the oplog records it, the server's change stream picks it up and fans out to clients. Putting the change stream in the worker would require a new IPC channel to reach the server's sockets — re-inventing a message bus that MongoDB's oplog already provides for free.

---

## Phase 6 — Bug Fix: Zod v4 UUID Validation (2026-03-28)

---

### Challenge: Zod v4 tightened UUID validation — test fixture UUIDs silently broke

**What happened:**
Three worker tests were failing with `saveEvent` never being called and `mockCh.ack` never firing. The test fixture used `id: "00000000-0000-0000-0000-000000000001"` — visually UUID-shaped, accepted by Zod v3. In Zod v4, `z.string().uuid()` validates against the full RFC 4122 spec including version nibble (`[1-8]`) and variant nibble (`[89abAB]`). The fixture ID has `0` in both positions and is not the special nil UUID (`...000`), so it fails parse — and the worker never reaches `saveEvent`.

**Why the failure mode was confusing:**
The tests were asserting `saveEvent` was called zero times, which looks like a mock not being applied — classic `vi.mock()` cross-contamination symptoms. The real cause was upstream: the Zod parse inside the worker threw before the storage call was ever reached. The stderr log showed the ZodError but it was easy to overlook when focused on mock assertion failures.

**The fix:**
Replace the fixture UUID with a proper RFC 4122 v4 UUID: `550e8400-e29b-41d4-a716-446655440000`.

**Anti-pattern avoided — "UUID-shaped" strings in test fixtures:**
Using hand-crafted IDs like `00000000-0000-0000-0000-000000000001` is convenient but not standards-compliant. When a validator enforces the spec strictly, these break silently (no compile error, no obvious test failure message). Use real UUIDs in fixtures — `crypto.randomUUID()` or a well-known valid UUID constant.

**Q:** Zod v4 rejects `00000000-0000-0000-0000-000000000001` as a UUID. Why?
**A:** RFC 4122 requires the 3rd group's leading nibble to be `[1-8]` (version) and the 4th group's leading nibble to be `[89abAB]` (variant). `00000000-0000-0000-0000-000000000001` has `0` in both positions. Zod v4 validates these bits strictly. Zod v3 accepted any UUID-shaped string. The only special-cased all-zero UUID is the exact nil UUID `00000000-0000-0000-0000-000000000000`.

**Q:** A worker test fails because `saveEvent` was never called, but your mock setup looks correct. What should you check first?
**A:** Check what happens *before* `saveEvent` is reached — specifically, whether the input passes schema validation. If Zod throws, the worker short-circuits and `saveEvent` is never invoked. The assertion failure ("called 0 times") looks like a mock problem but is actually an upstream parse failure. Always read the stderr output alongside the assertion failures.

---

## Phase 7 — Concepts: Node.js Event Loop Handle Ref-Counting (2026-03-29)

---

### Pattern: `timer.unref()` for background maintenance timers

**Where it appears:** `src/observation/metrics.ts` (`startMetrics` interval), `src/observation/wsServer.ts` (heartbeat interval)

**What it is:**
Node.js keeps the process alive as long as there are **ref'd handles** — open sockets, pending I/O, active timers. `setInterval` creates a ref'd handle by default. `.unref()` marks a handle as *background*: it still fires on schedule while other handles are active, but it will not prevent the process from exiting naturally when everything else has closed.

**Why it matters here:**
Both the stats broadcast interval and the WebSocket heartbeat are maintenance timers — they serve the system while it's running but should not *own* the process lifecycle. Without `.unref()`, after shutdown closes Fastify, the change stream, MongoDB, and AMQP, these timers would remain as live handles keeping the event loop spinning indefinitely.

**The nuance:**
In the current shutdown sequence, `stopMetrics()` calls `clearInterval` explicitly and `process.exit(0)` is called unconditionally — so the process exits regardless. `.unref()` is defensive hygiene: if either of those were removed or the code restructured, the timer wouldn't silently become a zombie that blocks natural exit.

**Anti-Pattern Avoided: Timers that own the process lifecycle**
A timer that *should* be background but isn't `.unref()`'d keeps the event loop alive even after all meaningful work is done. The process appears hung — no activity, no exit. This is especially subtle in test environments where the process not exiting causes test runners to timeout.

**Q:** What does `timer.unref()` do in Node.js?
**A:** It marks the timer as a background handle. It fires normally while other ref'd handles (sockets, I/O, other timers) are active, but it won't prevent the process from exiting when everything else has closed. The opposite, `timer.ref()`, re-registers it as a handle that keeps the event loop alive.

**Q:** Why do the metrics interval and WebSocket heartbeat both call `.unref()`?
**A:** Both are maintenance timers — they serve the system while it's running but shouldn't own the process lifecycle. Without `.unref()`, they'd keep the event loop alive after all real work (HTTP, MongoDB, AMQP) has been shut down, preventing natural process exit. They're background workers, not owners.

---
