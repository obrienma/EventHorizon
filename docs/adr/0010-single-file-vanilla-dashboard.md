# ADR 0010 — Single-File Vanilla JS Dashboard (No Framework, No Build Step)

**Status:** Accepted

---

## Context

The project needs a frontend to visualise the telemetry pipeline: live event stream, queue depth, processing rate, and event type distribution. The observation plane already exposes a WebSocket endpoint and a `GET /metrics` endpoint. A client UI must consume these.

The engineering and learning effort of this project is concentrated entirely in the backend data plane. A frontend decision must be made.

## Decision

The dashboard is a single `src/dashboard/index.html` file with inline JavaScript. No npm dependencies, no build step, no framework. The WebSocket connection, DOM updates, and chart rendering are written directly in vanilla JS using the browser's native `WebSocket` API.

## Rationale

The dashboard is not the project. Its entire purpose is to make the backend observable during development. Introducing React, Vue, or Svelte would require:

- A build pipeline (Vite, webpack, or similar) with its own configuration
- A dev server separate from the Fastify server
- npm dependencies that have nothing to do with the learning goals
- Significant time spent on component architecture, state management, and tooling

All of that effort would redirect focus away from the reactive data plane patterns this project is designed to teach.

A vanilla JS dashboard (~150–200 lines) exposes the WebSocket protocol directly — you read the code and immediately see what message types arrive, how they are parsed, and how the DOM is updated. There is no abstraction hiding the `onmessage` handler. This reinforces the WebSocket protocol design work done on the server (see ADR 0007).

The constraint of no build step also forces the WebSocket message protocol to be simple and self-describing — complexity cannot be hidden behind a serialisation library.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| React (+ Vite) | Component model; good for complex UIs | Build pipeline; npm deps; focus shifts to frontend |
| HTMX | Minimal JS; server-driven | Still a dependency; SSE/WS integration is non-obvious |
| Grafana (with MongoDB plugin) | Production-grade observability | Entirely out of scope; defeats the pipeline visibility goal |
| No dashboard at all | Zero distraction | Makes the pipeline invisible; harder to demonstrate and debug |

## Consequences

- `src/dashboard/index.html` is served as a static file by Fastify from the ingestion server.
- The file can be opened directly in a browser for local development without starting the server (with CORS caveats).
- No frontend test coverage — the dashboard is considered dev tooling, not production code.
- If the project were to grow a real user-facing product, this decision would be superseded by an ADR introducing a proper frontend build pipeline.
- Confidence: **High** for this scope. The constraint is intentional and well-bounded.
