# ADR 0002 — Fastify over Express

**Status:** Accepted

---

## Context

The project needs an HTTP framework to expose an ingestion endpoint and handle WebSocket upgrades for the observation plane. The two realistic candidates for a TypeScript/Node.js project are Express and Fastify.

Express is the default choice in most tutorials and has the largest ecosystem. Fastify is newer, built with performance and TypeScript as first-class concerns, and has native plugin support for WebSockets.

## Decision

Use **Fastify 5.x** as the HTTP framework, with `@fastify/websocket` for WebSocket support and Zod for request validation.

## Rationale

This project is about throughput and pipeline plumbing, not domain logic. Fastify's architecture is more instructive:

- **Type-first design**: Fastify's route type parameters expose request/reply shapes to the compiler in a way Express's `req`/`res` generics do not.
- **Performance**: Fastify's JSON serialisation and routing are measurably faster than Express, which matters when benchmarking a telemetry pipeline.
- **WebSocket upgrade path**: `@fastify/websocket` integrates cleanly with the existing Fastify lifecycle. Express requires `ws` or `socket.io` wired separately.
- **Plugin model**: Fastify's `register`/`decorate` pattern enforces encapsulation that Express middleware does not.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Express | Dominant ecosystem, most tutorials assume it | Looser TypeScript integration; middleware chain is less instructive for learning lifecycle hooks |
| Hono | Extremely fast, excellent TS support, edge-first | Smaller community; WS support less mature; less relevant to Node.js backend practice |
| Koa | Cleaner than Express, `async`/`await` native | No built-in routing; effectively abandoned; tiny ecosystem |

## Consequences

- Route handlers are typed via Fastify generic parameters, not cast from `any`.
- WebSocket upgrades go through `@fastify/websocket`, keeping the server lifecycle unified.
- Graceful shutdown uses `fastify.close()`, which triggers all registered `onClose` hooks — used by the shutdown sequence (see ADR 0006).
- The slightly smaller ecosystem relative to Express has not been a limitation at this scope.
