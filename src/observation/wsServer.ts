import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { WsMessage } from "../ingestion/event.schema.js";

// ── Pattern: Fan-out ──────────────────────────────────────────────────────────
// One incoming event (from the change stream) must be delivered to N connected
// WebSocket clients. The broadcast() function iterates the client set and sends
// to each. Clients are independent — a slow or failing client does not block
// delivery to the others.
//
// Design Decision — Map<WebSocket, boolean> over Set<WebSocket>:
// We need per-client state to implement zombie detection (is the client still
// alive?). A Map lets us store the "received pong since last ping" flag alongside
// the socket without a separate data structure.
//
// Anti-Pattern Avoided: Zombie Connections
// TCP connections can appear open when the remote peer is actually gone (process
// killed, network cut). Without a heartbeat, the server accumulates stale entries
// and eventually broadcasts to sockets that will never ack. The ping/pong cycle
// detects and terminates these within one PING_INTERVAL_MS window.

const clients = new Map<WebSocket, boolean>(); // socket → isAlive

const PING_INTERVAL_MS = 30_000;

// ── broadcast ─────────────────────────────────────────────────────────────────
// Exported so the change stream and metrics can push to all clients.
// Safe to call with zero connected clients — iterates an empty Map.

export function broadcast(message: WsMessage): void {
  const payload = JSON.stringify(message);
  for (const [socket] of clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    try {
      socket.send(payload);
    } catch (err) {
      console.error("[ws] send error, dropping client:", err);
      clients.delete(socket);
    }
  }
}

// ── registerWsServer ──────────────────────────────────────────────────────────
// Registers the @fastify/websocket plugin and the /ws route.
// Must be called before app.listen().

export async function registerWsServer(app: FastifyInstance): Promise<void> {
  await app.register(websocketPlugin);

  app.get("/ws", { websocket: true }, (socket) => {
    clients.set(socket, true);
    console.log(`[ws] client connected (total: ${clients.size})`);

    socket.on("message", (raw) => {
      // Client responds to our { type: "ping" } with the plain string "pong".
      if (raw.toString() === "pong") {
        clients.set(socket, true); // mark alive
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      console.log(`[ws] client disconnected (total: ${clients.size})`);
    });

    socket.on("error", (err: Error) => {
      console.error("[ws] client error:", err.message);
      clients.delete(socket);
    });
  });

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  // Every PING_INTERVAL_MS:
  //   isAlive=false → zombie, terminate + remove
  //   isAlive=true  → set false, send ping (client must pong before next cycle)
  const heartbeat = setInterval(() => {
    for (const [socket, isAlive] of clients) {
      if (!isAlive) {
        console.warn("[ws] terminating zombie connection");
        socket.terminate();
        clients.delete(socket);
        continue;
      }
      clients.set(socket, false);
      try {
        socket.send(JSON.stringify({ type: "ping" } satisfies WsMessage));
      } catch {
        clients.delete(socket);
      }
    }
  }, PING_INTERVAL_MS);

  // unref() prevents the timer from keeping the process alive after all other
  // handles are closed — important for clean shutdown without a forced exit.
  heartbeat.unref();

  console.log("[ws] server registered at /ws");
}
