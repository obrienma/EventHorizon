# ADR 0001 — TypeScript Strict Mode with NodeNext Resolution

**Status:** Accepted

---

## Context

The project is explicitly a learning vehicle for advanced backend patterns in TypeScript. Two key configuration decisions had to be made up front: how strict the type-checker should be, and how module resolution should work.

TypeScript offers a spectrum from loose (`"strict": false`, `"moduleResolution": "bundler"`) to strict (`"strict": true`, `"moduleResolution": "NodeNext"`). The choice made at the start of a project is hard to undo — loosening or tightening strict mode later causes widespread cascading changes.

Node.js 20+ with `"type": "module"` in `package.json` uses the full ESM specification, which has different resolution rules than CommonJS. TypeScript's `NodeNext` mode mirrors this exactly.

## Decision

Enable `"strict": true` and set `"moduleResolution": "NodeNext"` and `"module": "NodeNext"` in `tsconfig.json`. All local imports use explicit `.js` extensions (TypeScript resolves `.ts` → `.js` at emit time).

## Rationale

Strict mode forces explicit handling of `null`, `undefined`, and union types — the exact patterns a backend system must reason about carefully (connection objects that may not be initialised, queue messages that may be malformed, DB results that may be empty). Allowing implicit `any` or skipping null checks would remove the learning friction that makes the project valuable.

`NodeNext` resolution matches what the Node.js runtime actually does. Using `"moduleResolution": "bundler"` would make TypeScript happy while silently creating a gap between TS output and runtime behaviour — the `.js` extension requirement surfaces this contract explicitly.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| `"strict": false` | Less initial friction | Hides entire classes of real bugs; defeats the project's purpose |
| `"moduleResolution": "bundler"` | No `.js` extension required | Diverges from Node.js ESM reality; hides import resolution errors |
| CommonJS (`"type": "commonjs"`) | Simpler require/exports | Does not reflect modern Node.js practice; breaks top-level await |

## Consequences

- All nullable paths must be handled — `!` non-null assertions are banned unless a value is provably non-null.
- Every local import needs an explicit `.js` extension (e.g., `import { foo } from "./foo.js"`).
- Initial boilerplate is higher; the compiler surfaces problems early rather than at runtime.
- Downstream tooling (Vitest, tsx) must also be configured for ESM — see ADR 0009.
