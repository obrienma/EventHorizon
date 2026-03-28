# ADR 0007 — `@fastify/websocket` over socket.io

**Status:** Accepted

---

## Context

The observation plane must push real-time events to browser clients. Two common approaches in Node.js are socket.io and raw WebSockets via a library like `ws`. Socket.io is the default recommendation in most tutorials and has the widest name recognition.

The goal of this project is to understand the plumbing, not to ship a production chat application.

## Decision

Use **`@fastify/websocket`** (which wraps the `ws` library) for raw WebSocket connections. Define a custom, minimal JSON message protocol in the application layer. Do not use socket.io.

## Rationale

socket.io adds several layers above the WebSocket specification:

- A custom framing protocol (socket.io packets, not raw WS frames)
- Transparent fallback to HTTP long-polling when WebSockets are unavailable
- Built-in event namespacing and rooms
- Automatic reconnection logic on the client

Each of these is a useful feature in a production application. In a learning context they are liabilities: they hide what the wire protocol actually looks like, they abstract away the reliability model (you have to read socket.io docs to understand what "at-most-once" vs "at-least-once" means for socket.io events), and they tightly couple the client to the socket.io client library.

`@fastify/websocket` integrates with the existing Fastify lifecycle, so the WebSocket upgrade handler participates in the same `onClose` shutdown hooks as the HTTP server.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| socket.io | Rooms, namespaces, auto-reconnect, broad browser support | Hides wire protocol; custom framing; requires socket.io client; defeats learning goal |
| `ws` directly (no Fastify integration) | Minimal; no abstraction | Runs separate from Fastify; does not participate in Fastify lifecycle hooks; complicates shutdown |
| Server-Sent Events (SSE) | Built into browsers; no library needed; HTTP/2 compatible | Unidirectional (server → client only); no ping/pong or client commands possible |

## Consequences

- The client connects with a standard browser `new WebSocket(url)` — no client library required.
- The application-layer message protocol is defined explicitly in `observation/wsServer.ts`: `{ type: "event" | "stats" | "ping" }`.
- Reconnection on disconnect must be handled by the browser client (simple exponential backoff).
- Moving to socket.io in the future is straightforward: replace the handler, add the client library. The reverse would require a full rewrite.
- Confidence: **High** for this scope. If the project grew to require rooms or broadcast namespacing, socket.io or Ably would be reconsidered.
