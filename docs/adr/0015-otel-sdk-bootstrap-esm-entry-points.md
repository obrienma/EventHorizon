# ADR 0015 — OTel SDK Bootstrap Ordering in ESM Entry Points

**Status:** Accepted

---

## Context

EventHorizon has two independent process entry points: `src/server.ts` (Fastify + change stream) and `src/processing/worker.ts` (AMQP consumer). Both run under `tsx` in ESM mode (`"type": "module"`).

The OTel Node SDK must be fully initialised — `sdk.start()` called, instrumentation hooks registered — before any module it needs to instrument is loaded. In CommonJS, this is straightforward: `require('./tracing')` executes synchronously and patches the require cache before subsequent requires see the target modules. In ESM, all static imports are resolved into the module graph before any code executes, so the ordering question is more subtle.

Three approaches were considered:

1. **`--import` flag at the npm script level** — `tsx --import ./src/observation/tracing.ts src/server.ts`. This signals Node to load the preload module before the entry point. The concern: tsx's TypeScript-aware `--import` support for `.ts` files is not documented as stable, and there are two independent scripts to update.

2. **`NODE_OPTIONS="--import ./src/observation/tracing.ts"`** — same effect via environment variable. Same concern about TypeScript resolution at the Node level.

3. **First-import pattern** — add `import "./observation/tracing.js"` as the first static import in each entry file. ESM evaluates imports in depth-first, left-to-right order: a module listed first in an import block is fully evaluated before the modules listed after it. The OTel SDK's `sdk.start()` call in `tracing.ts` completes before `app.ts`, `queue.ts`, or `amqplib` are evaluated.

---

## Decision

Use the **first-import pattern** (option 3).

`import "./observation/tracing.js"` is the first line of `src/server.ts` and `import "../observation/tracing.js"` is the first line of `src/processing/worker.ts`.

---

## Rationale

The ESM evaluation guarantee is load-bearing: the spec requires that a module's dependencies are evaluated before the module itself, and that siblings are evaluated left-to-right. Placing `tracing.js` first in the import list is therefore a well-specified, runtime-agnostic guarantee — not a tsx implementation detail.

The `--import` flag approaches work but introduce friction: they require changes to npm scripts rather than source code, and the interaction between Node's `--import` and tsx's TypeScript loader adds an extra untested path. The first-import pattern keeps the bootstrap concern in the source file where a future reader will encounter it naturally.

The tradeoff: if someone adds a new entry point without knowing this convention, they will silently miss instrumentation. The in-file comment addresses this ("must be first — registers OTel hooks before any instrumented module loads").

---

## Consequences

- Both entry points are explicitly responsible for bootstrapping the SDK. Adding a third entry point requires the same first-import line.
- The `tracing.ts` module has side effects on import. This is intentional and documented; it must not be imported conditionally or lazily.
- Tests are unaffected: Vitest imports modules without going through either entry point, so the SDK never initialises in test runs. `trace.getActiveSpan()` returns `undefined` and `propagation.inject()` is a no-op — the test suite does not need a running collector.
