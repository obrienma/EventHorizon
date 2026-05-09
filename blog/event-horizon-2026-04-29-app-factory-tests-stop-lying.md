---
title: "Extracting the App Factory to Make Tests Stop Lying"
date: 2026-04-29
tags: [event-horizon, testing, fastify, typescript, refactoring]
summary: Importing a server module should not bind a port. It should not connect to MongoDB. It should not start a metrics interval. Once your tests can't import your server without ten unrelated things happening, you've already broken your own contract.
---

There's a refactor I made to EventHorizon recently that I want to write up, because the *symptom* was confusing and the *fix* was so structurally obvious in hindsight that I'm partly writing this post to make sure I don't make the same mistake again.

The symptom: my route tests were occasionally killing the entire Vitest worker process. Not failing — *crashing*. The test runner would print a single ominous line, the test file would never report results, and the next time I ran it everything was fine.

The fix: a fifty-line refactor that split one file into two. After the split, the bug was structurally impossible.

## What was actually happening

The original `src/server.ts` did everything in one file: created the Fastify instance, registered routes, called `connectDb()`, called `connectQueue()`, called `startMetrics()`, then `app.listen()` on port 3000. All at module top level. The exported value was the configured `app` instance.

The route tests imported `app` from `server.ts` to feed into Fastify's `inject()`:

```ts
import { app } from "../server.js";

it("returns 202 for a valid event", async () => {
  const res = await app.inject({ method: "POST", url: "/events", payload });
  expect(res.statusCode).toBe(202);
});
```

This worked, mostly. Until the dev server was already running on port 3000, in which case importing `server.ts` triggered `app.listen(3000)`, which threw `EADDRINUSE`, which the error handler caught and called `process.exit(1)` on. Vitest's worker process — which had been about to run the test file — disappeared. No assertion failure, no test report, just a single line about exit code 1 and a missing file from the results.

Worse: even when port 3000 was free, the test was triggering `connectDb()`, which tried to reach a MongoDB that might not be running (CI, fresh checkout, anything). It was triggering `startMetrics()`, which kicked off a polling interval that kept the process alive past the test's end. The "innocent" act of importing a module had detonated half the system's startup sequence.

## The thing I'd been doing wrong

I had violated a principle that I'd internalised intellectually but apparently not structurally: **importing a module should be a pure, declarative operation.** Loading a file should not connect to a database. Loading a file should not bind a port. Loading a file should not start an interval. If it does any of those things, that file is no longer importable in any context except the one it was designed for.

Tests are not the only context that breaks here. CLIs that need to load configuration. Scripts that want to validate routes without running a server. Linters or type-only static analysis tools. *Anything* that imports the module pays the side-effect cost. The module has stopped being a library and become a launcher.

This is the *Import = Side Effect* anti-pattern. It has many faces, and I've stepped on all of them at one point or another. Top-level `await connectThing()`. Module-level `setInterval(...)`. Class instances that connect in their constructor and are exported as singletons. They all have the same shape: importing the file does work that shouldn't be done at import time.

## What "port 0" doesn't fix

When I first noticed the EADDRINUSE crashes, my instinct was to dodge: pass port 0 in the test environment, get an OS-assigned random port, no collisions. That works! The collision goes away. But it doesn't fix anything else.

`connectDb()` still fires on import. `connectQueue()` still fires on import. `startMetrics()` still fires on import. The test still depends on infrastructure being available. CI still slows down by however long those connections take. The interval still keeps the process alive past the test's natural end.

Port 0 fixes one symptom. The disease — *I/O at import time* — is intact. I went looking for a structural fix instead.

## The split

The factory pattern, applied:

```ts
// src/app.ts — pure construction. No I/O. Safe to import anywhere.
export function buildApp(): FastifyInstance {
  const app = fastify({ logger });
  registerWsServer(app);
  app.register(eventRoutes);
  return app;
}

// src/server.ts — entry point. All I/O lives here. Never imported by tests.
import { buildApp } from "./app.js";

const app = buildApp();

await connectDb();
await connectQueue();
startMetrics();
await app.listen({ port: config.PORT });

process.on("SIGTERM", shutdown);
```

Two files. One responsibility each.

`app.ts` constructs and configures the Fastify instance. It registers routes, plugins, hooks. It does not connect to anything. It does not bind a port. It returns a fully configured-but-inert object. Importing it has no observable side effects beyond the imports it itself performs.

`server.ts` is the *entry point*. It imports `buildApp` from `app.ts`, runs all the startup I/O, binds the port, and registers signal handlers. Tests never import it. It is the file you run, not a file you reuse.

The route tests now look like:

```ts
import { buildApp } from "../app.js";

let app: FastifyInstance;
beforeEach(() => { app = buildApp(); });

it("returns 202 for a valid event", async () => {
  const res = await app.inject({ method: "POST", url: "/events", payload });
  expect(res.statusCode).toBe(202);
});
```

Each test gets a fresh app instance. No shared state. No port binding. No infrastructure dependencies. `inject()` exercises the full route handler — Fastify's request/response lifecycle, schema validation, the lot — without a real socket. This is exactly what `inject()` was designed for.

## Why this is the right boundary

The factory split makes the contract *structural*, not procedural. I considered an alternative first: keep the single file, wrap the I/O in a `start()` function, only call `start()` in `server.ts`'s entry-point block. That would have worked! But it would have left the door open for a future me — or a teammate, or a confused refactor — to call `start()` from a test setup file. The temptation would still exist. The fragile contract would still need to be remembered.

The split removes the temptation entirely. `app.ts` *can't* start a server, because it doesn't import `app.listen` callers, doesn't import infrastructure connectors, doesn't have anything to start. There is no `start()` button to accidentally press. The structure of the codebase enforces the rule.

This is the difference between "we agree not to call this function in tests" (procedural, fragile, dependent on memory) and "this function does not exist in the test-importable module" (structural, robust, dependent on the module graph). When you can move a constraint from runtime convention to compile-time structure, do it.

## What the test failure was actually telling me

The flaky tests weren't a test problem. They were a *design feedback signal*. The test was doing the simplest possible thing — `import the module, use the export` — and the system was making that simple thing impossible.

Whenever a test feels like it's working unreasonably hard to set up — manually killing intervals, mocking infrastructure connections that have nothing to do with the assertion, running in serial because parallel imports collide — the failure is almost always in the production code, not in the test. The test is showing you, with great precision, that something in the production code can't be used flexibly.

I've started using "what does this test require me to do?" as a design heuristic. If a unit test for a route handler requires a running MongoDB, the route handler's imports are wrong. If a unit test for a worker requires a real RabbitMQ, the worker's wiring is wrong. The test isn't lying about what's needed; the test is the most honest reading of the dependency graph you'll ever get.

## What changed in my mental model

Before this refactor I'd have said: *modules with side effects on import are an anti-pattern.* I'd have nodded along to the principle and then violated it the next time I wrote a server file, because every Node.js example you read does the same thing — `app.listen()` at the bottom of `server.ts`, top-level `await`, all of it.

After this refactor I've started to think of it as a *structural* rule, not a stylistic one: **the file you `node X.js` and the file you `import { Y } from "X.js"` should never be the same file.** The first is an entry point; it's allowed to do startup work. The second is a library; it must not. If the same file is doing both jobs, there is a refactor waiting to happen.

This rule is easy to apply on day one of a project — split immediately, never get the antipattern. It's harder to apply retroactively, because by the time you notice, the imports are entangled and the refactor has surface area. EventHorizon's split was small (50 lines, one file → two files, one test file updated). A larger app would be much bigger. The cost of the discipline is much smaller than the cost of fixing it later.

## The boring takeaway

A server module that does I/O at import time is a server module that can only be used as a server. Once you split construction from startup, every other use case — testing, scripting, type-checking, lazy initialisation — opens up at zero additional cost. The split takes a couple of minutes. The benefits compound for the lifetime of the project.

Tests stopped killing my Vitest workers. They also stopped lying about what the system needs to run. Both are nice. The second one is the more durable win.
