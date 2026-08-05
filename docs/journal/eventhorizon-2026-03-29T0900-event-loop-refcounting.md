---
id: eventhorizon-2026-03-29T0900-event-loop-refcounting
repo: eventhorizon
title: "Concepts: Node.js Event Loop Handle Ref-Counting"
date: 2026-03-29
phase: 7
tags: [nodejs, event-loop, timer-unref, graceful-shutdown, background-timers]
files: [src/observation/metrics.ts, src/observation/wsServer.ts]
---

### Pattern: `timer.unref()` for Background Maintenance Timers

Node.js keeps the process alive as long as there are ref'd handles — open sockets, pending I/O, active timers. `setInterval` creates a ref'd handle by default; `.unref()` marks a handle as background, so it still fires on schedule while other handles are active, but won't prevent the process from exiting naturally once everything else has closed. Both the stats broadcast interval (`src/observation/metrics.ts`) and the WebSocket heartbeat interval (`src/observation/wsServer.ts`) are maintenance timers that serve the system while it's running but shouldn't own the process lifecycle — without `.unref()`, after shutdown closes Fastify, the change stream, MongoDB, and AMQP, these timers would remain live handles keeping the event loop spinning indefinitely. In the current shutdown sequence, `stopMetrics()` calls `clearInterval` explicitly and `process.exit(0)` is called unconditionally, so the process exits regardless — `.unref()` is defensive hygiene, guarding against a future restructuring where those explicit calls are removed or changed and the timer would otherwise silently become a zombie blocking natural exit.

### Anti-Pattern Avoided: Timers That Own the Process Lifecycle

A timer that should be background but isn't `.unref()`'d keeps the event loop alive even after all meaningful work is done — the process appears hung, with no activity and no exit. This is especially subtle in test environments, where the process not exiting causes test runners to time out.
