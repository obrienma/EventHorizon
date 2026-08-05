---
id: eventhorizon-2026-04-25T0900-app-factory
repo: eventhorizon
title: "Testability Refactor: App Factory"
date: 2026-04-25
phase: 8
tags: [app-factory, import-side-effects, testability, fastify, dependency-injection]
files: [src/server.ts, src/app.ts, src/ingestion/event.routes.test.ts]
---

### Anti-Pattern Avoided: Import = Side Effect

The original `src/server.ts` was a single module that both exported a value (`app`) and executed startup I/O when imported — calling `app.listen()`, `connectDb()`, `connectQueue()`, and `startMetrics()` at module top-level. The failure mode this caused: the routes test imported `server.ts` to get the `app` instance for `inject()` calls, and importing triggered `app.listen()`, which tried to bind port 3000. When the dev server was already running on that port, the error handler called `process.exit(1)`, killing the entire Vitest worker process before any test ran. Using port 0 (an OS-assigned random port) would not have fixed it — it only sidesteps the port collision, not the fact that `connectDb()`, `connectQueue()`, and `startMetrics()` still fire at import time; those calls either fail outright (infrastructure not running in CI) or add real startup latency to every test. The root cause — I/O at import time — remains regardless of the port.

### Pattern: App Factory

The fix splits the server module into two distinct responsibilities: `src/app.ts` does pure construction — creating the Fastify instance and registering plugins and routes, with no network I/O, safe to import in any test or context — while `src/server.ts` is the entry point that imports `app`, runs all startup I/O (DB, queue, change stream, metrics), binds the port, and registers signal handlers; it is never imported by tests. Tests using Fastify's `inject()` don't need a real socket — they call the route handler directly through the framework's injection layer, needing only the configured `app` object, not a listening server, a database connection, or a running metrics interval. A `start()` function inside one file was considered and rejected: it still requires the test to explicitly not call it, which is fragile, since a future developer or test setup might call it. The split makes the contract structural instead — `app.ts` cannot start a server because it has no `listen()` call at all, so a test importing `app.ts` gets a pure value with no affordance for side effects.
