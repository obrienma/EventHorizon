# ADR 0012 — Zod over Valibot

**Status:** Accepted

---

## Context

The project needs a runtime schema validation library for validating incoming HTTP event payloads, environment variables, and deriving TypeScript types via `z.infer<>`. Two modern candidates are Zod and Valibot.

Valibot markets itself as a lightweight alternative to Zod, with a significantly smaller bundle size achieved through a modular, tree-shakeable API.

## Decision

Use **Zod** as the schema validation library across all planes.

## Rationale

The bundle-size argument for Valibot does not apply here. This is a server-side Node.js application — schemas are never shipped to a browser client, so download size is irrelevant. The Valibot trade-off (smaller bundle at the cost of a more verbose, unfamiliar API) offers no benefit in this context.

Zod is the de-facto standard in the TypeScript/Node.js ecosystem. It has wider adoption, more ecosystem integrations (e.g. with Fastify via `@fastify/type-provider-zod`), and vastly more community examples, Stack Overflow answers, and library interop. The `z.infer<>` pattern for deriving types from schemas is well understood across the ecosystem.

Valibot's modular API (importing individual validator functions rather than chaining methods) is more verbose for the schema definitions in this project and would introduce a non-standard pattern that adds friction without a compensating benefit.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Valibot | Smaller bundle; tree-shakeable; similar feature set | Bundle size irrelevant server-side; less ecosystem adoption; more verbose API |
| `io-ts` | Functional programming style; strong TypeScript inference | Steep learning curve; very verbose; ecosystem traction declining |
| `class-validator` | Decorator-based; familiar to OOP developers | Requires `experimentalDecorators`; tightly coupled to class instances; not idiomatic for functional pipelines |

## Consequences

- All schemas are defined with `z.object(...)` and types derived exclusively via `z.infer<typeof Schema>` — no manually written parallel type definitions.
- `src/ingestion/event.schema.ts` is the single source of truth for the `AppEvent` shape shared across all planes.
- `src/config.ts` uses Zod to validate all environment variables at startup, exiting the process on any invalid config.
- Confidence: **High**. This is a straightforward server-side context where Zod's ecosystem maturity is the dominant factor.
