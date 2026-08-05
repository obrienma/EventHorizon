---
id: eventhorizon-2026-03-26T0900-foundation
repo: eventhorizon
title: "Foundation: Config Validation and Event Schema"
date: 2026-03-26
phase: 1
tags: [fail-fast, zod, discriminated-union, schema-as-contract, typescript, nodenext, ambient-declarations]
files: [src/config.ts, src/ingestion/event.schema.ts, src/global.d.ts]
---

### Pattern: Fail-Fast / Boundary Validation

Validate all external inputs — environment variables, config files, API payloads — at the earliest possible boundary, before any application logic runs, and crash loudly with a clear error message rather than letting invalid state propagate deeper into the system. `src/config.ts` is the first file executed at startup: if `MONGO_URI` is missing or `WORKER_PREFETCH` isn't a valid integer, the process exits immediately with a field-level error instead of failing silently thirty seconds later with a cryptic MongoDB connection error. The naive pattern `const port = Number(process.env.PORT) || 3000` has two failure modes that Zod's `safeParse` avoids: silent coercion (`Number("abc")` returns `NaN`, which is falsy and passes the `|| default` check) and no error reporting (there's no way to know which variable failed or why). Zod's `safeParse` instead returns a structured error array with field paths and messages.

### Pattern: Discriminated Union (Sum Type)

A discriminated union is a type that can be one of several distinct shapes, distinguished by a shared literal field — the discriminant — that lets TypeScript narrow to the correct shape once it's checked, giving exhaustive type safety in switch/if blocks with no `as` casts required. EventHorizon processes three event types — `pipeline`, `sensor`, `app` — each with different required fields, discriminated on `"type"` in `src/ingestion/event.schema.ts`. The ingestion plane rejects events that don't match any known shape, and the processing plane can switch on `event.raw.type` to get fully-typed access to shape-specific fields: `if (event.raw.type === "sensor") { event.raw.sensorId; }` typechecks with no cast needed.

### Pattern: Schema-as-Contract (Single Source of Truth for Types)

Types are defined once as Zod schemas, and every TypeScript type is derived from those schemas via `z.infer<typeof Schema>` — never hand-written as a parallel interface. All planes import event types from `src/ingestion/event.schema.ts`. Without this pattern, a Zod schema and a hand-written interface can silently diverge, because the compiler can't catch two separate declarations drifting apart from each other. With `z.infer<>`, the type IS the schema: one definition, zero drift. This is the **Type Duplication / Schema Drift** anti-pattern avoided — `const SensorSchema = z.object({...}); interface SensorEvent { sensorId: string; value: number; }` (a hand-written copy) can diverge silently from the schema it's meant to mirror, whereas `type SensorEvent = z.infer<typeof SensorSchema>` can never drift, because it isn't a separate declaration at all.

### Challenge: TypeScript 6 + NodeNext — `process` and `console` Not Found

After writing `src/config.ts`, the compiler reported `error TS2591: Cannot find name 'process'` and `error TS2584: Cannot find name 'console'`. TypeScript 6 with `"module": "NodeNext"` treats every `.ts` file containing `import`/`export` as an ES module, and `@types/node`'s `declare global {}` augmentations for `process`/`console`/etc. only apply in ambient (non-module) context — since `config.ts` has imports, it's a module, and the global augmentation doesn't surface, even though `"types": ["node"]` in `tsconfig.json` correctly resolves `@types/node`. The fix was creating `src/global.d.ts`, a file with no `import` or `export` — making it an ambient declaration file — containing only `/// <reference types="node" />`. Because it's ambient, it applies globally to the entire compilation, surfacing `process`, `console`, `Buffer`, and the rest of Node's globals across all module files.

### Anti-Pattern Avoided: Leaky Abstraction (Wrong `lib` Fix)

The tempting wrong fix for the `process`/`console` error was adding `"dom"` to the `lib` array in `tsconfig.json`, since `dom` declares a `console` global — but it's the browser's console, not Node's. This is the Leaky Abstraction anti-pattern: it imports the browser's entire type universe into a server-side Node.js module, so `document`, `window`, `localStorage`, and the browser's `fetch` all typecheck without error, silently losing the compiler's signal when code accidentally references a browser API that won't exist at runtime. The correct fix — the ambient `global.d.ts` reference above — pulls in exactly Node's global declarations and nothing else, keeping the compiler's correctness guardrail intact.
