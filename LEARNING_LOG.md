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

## Phase 2 — Server skeleton (2026-03-26)

Files built: `src/server.ts`

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
