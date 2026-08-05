---
id: eventhorizon-2026-03-28T0915-observation-plane
repo: eventhorizon
title: "Observation Plane"
date: 2026-03-28
phase: 4
tags: [event-driven-push, change-streams, fan-out, websocket, zombie-connections, heartbeat, event-loop, process-boundaries]
files: [src/observation/changeStream.ts, src/observation/wsServer.ts, docker-compose.yml, .env, src/server.ts, src/ingestion/event.routes.test.ts]
---

### Pattern: Event-Driven Push (Change Streams)

Instead of clients polling "are there new events?" on a timer, `src/observation/changeStream.ts` inverts control: MongoDB pushes each committed insert to the observer the moment it appears on the oplog, and the observer fans out to WebSocket clients. A one-second poll on a busy collection returns all documents since the last check — most already seen — while a change stream delivers exactly one notification per insert with zero redundant reads, dropping latency from up to the poll interval to near-zero. Change streams are built on MongoDB's oplog, which only exists on replica set members; a standalone instance has no oplog and throws `MongoServerError` on `watch()`. The fix is to run MongoDB as a single-node replica set (`--replSet rs0`) — from the application's perspective it is identical to a standalone, one node, same connection string, but it has an oplog. When a replica set member reports its hostname to the driver, it uses the container's internal hostname, not `localhost`; without `directConnection=true` in the URI, the driver performs RS topology discovery and may try to connect to the container hostname directly, which fails from the host machine. `directConnection=true` skips discovery and connects to the specified host directly, and change streams still work because the node IS a replica set member.

### Pattern: Fan-out

`broadcast()` in `src/observation/wsServer.ts` delivers one incoming message — a change stream insert event — to N connected WebSocket clients by iterating the client `Map` and calling `socket.send()` on each. Clients are independent; a slow or erroring client is removed and does not block delivery to others.

### Anti-Pattern Avoided: Zombie Connections

TCP connections can appear open when the remote peer is actually gone (process killed, network partition). Without a heartbeat, the server accumulates stale `Map` entries, and each broadcast wastes time iterating sockets that will never receive the message. The fix is a ping/pong heartbeat in `registerWsServer()`: every `PING_INTERVAL_MS` (30s), a client with `isAlive === false` is a zombie — `socket.terminate()` and remove from the Map — while a client with `isAlive === true` is reset to `false` and sent `{ type: "ping" }`; receiving `"pong"` from the client sets `isAlive = true`. A live client resets its flag within 30 seconds; a zombie never responds and gets terminated on the next cycle. A `Set<WebSocket>` would suffice for broadcast alone, but zombie detection requires per-client state (`isAlive`), so a `Map<WebSocket, boolean>` stores both in one structure. `heartbeat.unref()` prevents the `setInterval` from keeping the Node.js event loop alive after all other handles close — without it, a graceful shutdown would hang waiting for the timer to fire.

### Decision: Change Stream Lives in the Server Process, Not the Worker

The worker writes events to MongoDB, raising the question of why the change stream doesn't live there too, since it's watching those same writes. The answer is that the worker and server are separate OS processes with no shared memory: `broadcast()` holds a `Map<WebSocket, boolean>` of live client sockets that only exist in the server process's memory, so the worker cannot reach them — calling `broadcast()` from the worker is physically impossible without adding another IPC channel. MongoDB acts as the process boundary: the worker's RabbitMQ-consume-then-`insertOne()` path and the server's `watch(oplog)`-then-`broadcast()` path never touch each other directly — the worker doesn't know the server exists, and the server doesn't know the worker exists; they are decoupled through MongoDB, where the worker writes, the oplog records it, and the change stream picks it up. This is Event-Driven Push applied at the process boundary. The alternative is worse: if the change stream were in the worker, it would need a way to send events across the process boundary to the server's WebSocket clients — another IPC channel, a shared Redis pub/sub, an internal HTTP call, another queue — reinventing a message bus that already exists, since MongoDB's oplog provides that notification channel for free.
