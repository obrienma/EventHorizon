# ADR 0009 — Vitest over Jest

**Status:** Accepted

---

## Context

The project uses TypeScript with `"module": "NodeNext"` and `"type": "module"` in `package.json`, meaning all source files are native ES modules. A test runner must be chosen that can execute these files without a separate transpilation or transformation step that fights the module system.

Jest is the dominant test framework in the Node.js ecosystem. Vitest is newer, built on Vite, and designed with ESM as the default.

## Decision

Use **Vitest** as the test runner. Configure it with `pool: "forks"` to isolate test environments across files. Use `mongodb-memory-server` for repository-layer tests that require a real MongoDB instance.

## Rationale

Jest requires `babel-jest` or `ts-jest` to handle TypeScript, and additional ESM transformation configuration (`--experimental-vm-modules` flag, `transform` config, `extensionsToTreatAsEsm`) to work with native ESM. This configuration fights against `NodeNext` resolution: Jest's module mock system (`jest.mock()`) does not work cleanly with ESM without workarounds that vary by Jest version.

Vitest handles TypeScript and ESM natively. `vi.mock()` works with static ES imports. The watch mode is significantly faster due to module graph caching. The `expect` API is Jest-compatible, so there is no learning penalty.

`mongodb-memory-server` integrates with Vitest's global setup hooks (`globalSetup`/`globalTeardown`) cleanly, allowing a real MongoDB process to be started once per test run and shared across all repository tests.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Jest | Largest ecosystem; most tutorials assume it | Requires complex ESM shim config with `NodeNext`; `jest.mock()` ESM incompatibilities |
| Node.js built-in `node:test` | Zero dependencies | No mocking utilities; no snapshot testing; ecosystem tooling (coverage, reporters) is limited |
| Mocha + Chai | Flexible; runs ESM natively | No built-in mocking; requires assembling multiple libraries; slower iteration |

## Consequences

- Tests use `import` (not `require`) consistently with the rest of the codebase.
- `vi.mock("../path/to/module.js")` is used for mocking — the `.js` extension is required (mirrors the NodeNext import rule).
- Coverage is collected via Vitest's `@vitest/coverage-v8` provider.
- The `vitest.config.ts` file must explicitly set `environment: "node"` to avoid Vitest defaulting to a jsdom environment.
- Confidence: **High**. Vitest has stabilised as the standard choice for ESM TypeScript projects.
