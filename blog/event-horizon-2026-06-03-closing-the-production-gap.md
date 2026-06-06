---
title: "Closing the Gap: Persistent Tokens, Containers, and the Road to k3s"
date: 2026-06-03
tags: [event-horizon, distributed-systems, kubernetes, docker, deployment]
summary: The previous post listed what EventHorizon needed before it could run in production. This one closes the list — persistent resume tokens, a multi-stage Dockerfile, a dependency-aware health check, and k3s manifests. Along the way, a silent data-loss bug that the test suite missed entirely.
draft: true
---

The last post in this series ended with a list. Persistent resume token. Dockerfile. Health check. Kubernetes manifests. "Conventional work," I called it — nothing that changes the application architecture, but the application doesn't run in production until it's done.

This post is about doing it.

---

## The bug we didn't know we had

Before any of the deployment work, a code review turned up something uncomfortable.

In the worker's retry path, `ch.publish()` was called to republish a failed message, and then `ch.ack()` was called unconditionally on the next line. The problem: `amqplib`'s `channel.publish()` returns a boolean. `true` means the message was written to the channel's internal buffer. `false` means the broker's write buffer was full — the broker was applying flow control, and the message was not queued.

When `publish()` returned `false`, we were acking the original message anyway. The message was permanently gone. No exception, no log, no rejected promise. The only signal was a return value we weren't reading.

The fix is one line: capture the return value, only ack if `published === true`. If `false`, don't ack — leave the message unacked, let RabbitMQ redeliver it. The occupied prefetch slot applies backpressure to the consumer while the broker drains, which is exactly the right behaviour under load.

What made this interesting wasn't the fix. It was why the existing tests hadn't caught it.

The mock was declared as `vi.fn()`, which returns `undefined` by default. `undefined` is falsy — identical to a `false` return from the real channel. So the existing tests were passing, asserting that `ack` was called after a failed `publish()`. They were testing the broken code path and asserting on its wrong outcome. The mock had *false fidelity*: it appeared to match the real API but was silently validating the bug.

The fix required two changes: changing the mock default to `mockReturnValue(true)` (matching real `amqplib` under normal conditions), then adding one explicit test for the `false` case. The lesson is that a passing test suite is not evidence of correct behaviour if your mocks don't model the real API's failure modes.

---

## The circular dependency that wasn't

The previous post described the in-memory resume token as a known shortcut. ADR-0011 documented the trade-off explicitly: persisting the token to MongoDB would allow recovery across restarts, but added a "circular dependency" — you'd need MongoDB to load the token to reconnect to MongoDB.

When we came back to it, that concern didn't hold up.

The circular dependency only matters if MongoDB is completely unavailable at startup. But if MongoDB is down, you can't open the change stream regardless — the token is irrelevant until MongoDB is reachable. Once reachable, loading the token and opening the stream are both possible. The "circular dependency" collapses to "if Mongo is down, you wait until it's up," which was already true without a persistent token.

The implementation is a single MongoDB collection (`changestream_checkpoints`, one document) with three functions: `loadResumeToken`, `saveResumeToken`, `clearResumeToken`. On startup, `startChangeStream` loads the saved token — making the function async, the only signature change. On each delivered event, `saveResumeToken` is called fire-and-forget. A failed write is logged but doesn't block delivery. Worst case on a write failure: on the next pod restart, the token is slightly behind the last delivered event, so a few events replay. The idempotent insert in `event.repository.ts` absorbs them.

There's one new failure mode: oplog overrun. If the server is down long enough that MongoDB's oplog rolls past the saved token, MongoDB rejects the token with error code 286 (`ChangeStreamHistoryLost`). The original in-memory implementation would have entered an infinite retry loop with a stale token. The persistent implementation detects the code, clears the checkpoint, resets the backoff, and restarts from the current oplog head. The events during the gap are missed — that's the accepted trade-off — but the stream recovers immediately rather than hanging forever.

ADR-0011 is now marked superseded. ADR-0013 documents the new decision, including a direct rebuttal of ADR-0011's circular-dependency concern.

---

## One image, two pods

The Dockerfile required one design decision worth naming: the server and worker are the same image with different entry points.

Both processes share the entire codebase — same `src/`, same `tsconfig.json`, same `package.json`. Two Dockerfiles would duplicate every build step and drift out of sync over time. Instead, one multi-stage build compiles TypeScript to `dist/`, and the k3s manifests run:

- `node dist/server.js` (the default `CMD`)
- `node dist/processing/worker.js` (overriding `CMD` in the worker Deployment)

One image, one build, two processes. Image updates roll to both deployments simultaneously from the same tag.

The build itself has a subtlety worth noting. `tsconfig.json` includes `src/**/*`, which covers `*.test.ts` files. A naive `tsc` build compiles them into `dist/`, dragging `vitest` and `mongodb-memory-server` imports into the production image. They're never executed, but they're noise and they inflate the layer.

The fix is a `tsconfig.build.json` that extends the root config and adds `"exclude": ["src/**/*.test.ts"]`. This prevents new test compilations — but `tsc` doesn't delete previously compiled files that are no longer in scope. Any test `.js` files from a prior build stay in `dist/` until you clean it. The build script became `"build": "rm -rf dist/ && tsc -p tsconfig.build.json"`. The clean step is the load-bearing part.

The final image is ~181 MB: `node:24-alpine` base, production `node_modules` only, compiled JS, non-root user. No TypeScript compiler, no test runner, no `tsx`.

---

## What a health check actually is

A health endpoint that always returns `200` is a vanity probe. It proves the HTTP server is alive — something the orchestrator can determine from a TCP connection — and says nothing about whether the application can do useful work.

The right probe touches the minimum set of dependencies needed to handle a real request. For the server, that means MongoDB. A `db.command({ ping: 1 })` on every probe request: `200 { status: "ok", mongo: "ok" }` if it succeeds, `503 { status: "degraded", mongo: "error: <message>" }` if it doesn't.

This matters for both k3s probe types:

*Liveness* — "Is this process alive and not stuck?" Failure restarts the pod. A dead MongoDB connection that can't recover should eventually trigger a restart.

*Readiness* — "Can this pod handle traffic?" Failure removes the pod from the Service's endpoint list without restarting it. A pod that hasn't finished connecting to MongoDB on startup should not receive requests yet.

The same `/healthz` endpoint serves both in the k3s manifests. You'd split them — a fast liveness check, a more thorough readiness check — only if you need different restart versus traffic-shedding behaviour. For this pipeline, one probe is enough.

The worker has no HTTP server and therefore no `/healthz` endpoint. It relies on `restartPolicy: Always` (the Deployment default) to restart on process exit. A more sophisticated approach — an exec probe that checks the age of a heartbeat file written after each successful ack — is documented as a TODO in `k3s/worker.yaml`. For now, if the worker crashes, k3s restarts it; if it hangs silently, the queue depth dashboard makes it visible.

---

## Two replicas for free

The worker Deployment sets `replicas: 2`. This is the Competing Consumers pattern applied at the Kubernetes level: two worker pods consuming from the same durable queue, RabbitMQ round-robining messages between them.

Why is this safe without any additional code? Because the architecture was designed for it from phase one.

The unique index on `raw.id` means that if two workers race to write the same event — due to a broker redeliver, a network blip, or any other duplicate-delivery scenario — one write succeeds and the other hits error 11000, which is silently swallowed. The idempotent receiver absorbs concurrent duplicates the same way it absorbs sequential ones.

At two replicas with `WORKER_PREFETCH=5`, the maximum in-flight message count across the cluster is 10. When all 10 slots are occupied, the broker stops delivering to both consumers. Message 11 sits in the queue until a slot opens. This is correct backpressure: the broker holds the work, not the consumers' memory. The prefetch limit is not a buffer size — it's a flow control valve.

The competing-consumers property was the design goal. The architecture was validated at one replica; running two is the deployment.

---

## What's left

The k3s checklist is done. The remaining gaps from the previous post's "what's missing" section — authentication, multi-tenancy, rate limiting, Prometheus metrics — are still open. Those are production hardening concerns, not deployment prerequisites. EventHorizon now has the skeleton of a deployable service: a container image, a health probe k3s can use, manifests that describe the desired state, and a persistent cursor that survives the restarts a managed environment guarantees.

The patterns held. The architecture that was correct for a single-process learning project needed almost no structural change to become deployable. The idempotent receiver absorbed competing consumers. The seven-step shutdown worked the same in a container as it did locally. The App Factory split made the two-entry-point image trivial.

The one thing that changed was the resume token — and that changed because the operating assumption changed, not because the pattern was wrong. In-memory state is fine when you control restarts. In k3s, you don't. The durable checkpoint was always the correct pattern for a managed environment; we just didn't need it until now.
