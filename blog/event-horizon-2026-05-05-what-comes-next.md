---
title: "What Comes Next: Multi-Server Deployments, Persistent Resume Tokens, and the Patterns That Transfer"
date: 2026-05-05
tags: [event-horizon, distributed-systems, retrospective, kubernetes, observability]
summary: EventHorizon is feature-complete. It is also a single-server toy. The interesting question is which of its patterns survive the move to a real production environment, and which need to be reworked entirely.
---

I'm calling EventHorizon done. The four planes are wired. The pipeline self-heals on transient cursor failures. The dashboard pushes events live. The shutdown sequence drains cleanly. The test suite covers what it should cover, and the gaps are documented. The series of blog posts you've just read is, in a real sense, the project's retrospective.

But "done" is doing some work in that sentence. EventHorizon is *done as a learning vehicle*. It is not done in the sense that you could deploy it tomorrow and run someone's production telemetry through it. The gap between those two states is the subject of this final post.

I want to walk through what would have to change, what wouldn't, and — most usefully — *which of the patterns I've written about in this series transfer beyond their specific implementations.* Patterns are interesting, implementations are disposable. The question is which is which.

## What works as-is

Surprisingly, more than I'd expected on day one.

**The four-plane shape.** Ingestion → Processing → Storage → Observation, one direction only, no backflow. This holds at any scale. In a production system, each plane becomes its own deployable service (or set of services), but the shape is unchanged. The discipline of "data flows one direction" is independent of how many processes or pods you have.

**At-least-once + idempotent receiver.** The unique index on `raw.id`, the silent swallow of error code 11000, the save-before-ack ordering — all of this is correct at scale. In fact, it gets *more* correct, because at scale you have more workers competing for messages and the duplicate-delivery cases that this pattern handles become more frequent. The contract was designed for the failure modes that scale exposes; running it small was the test, running it large is the deployment.

**Three-strikes dead-letter.** Application-level retry with `x-retry-count` headers, dead-letter exchange for terminal failures. Identical at any scale. The DLQ becomes a more important operational concern (you actually need a tool to triage it), but the retry mechanism itself doesn't change.

**Append-only storage.** Every event is a sealed document. Mutations are forbidden. This pattern *especially* shines at scale, because append-only collections are easier to shard, easier to time-series-partition, easier to migrate, and easier to reason about under concurrent writes. The constraint that felt fussy on day one is the constraint that makes the storage layer survive a 100x growth in event volume.

**The seven-step shutdown.** Order matters at any scale. The list of resources gets longer in production (multiple consumers, multiple connections, lifecycle hooks for the orchestrator), but the *principle* — tear down in the reverse order of the data flow, drain before close, exit explicitly — is what you'd write for a much bigger system, just with more steps.

Five patterns, all transferable, all already correct in EventHorizon. That's most of the architectural value of the project.

## What's a single-server shortcut

A handful of things only work because there's one server.

**The in-memory resume token.** Right now, the change stream's resume token lives in a closure variable in the server process. A server restart loses it. Events written during the outage are not replayed to the dashboard.

In production, you'd want to persist the token. The right place depends on the deployment: a small Redis instance, a dedicated MongoDB collection, a local file checkpoint. The trade-off is one I deferred deliberately (ADR 0011): in exchange for a startup-read path and some new failure modes around stale or corrupt tokens, you get cross-restart continuity. It's the next thing I'd implement if I needed it.

**The single-process server.** EventHorizon's `server.ts` runs Fastify, the change stream, the metrics interval, and the WebSocket server *in one process.* That's fine for one-server scale. At larger scale, you'd separate them: the HTTP server is one deployment, the change-stream-to-WebSocket fan-out is another, the metrics poller is a third. Each can scale independently. Each can fail independently.

The interesting bit: the App Factory pattern (covered in an earlier post in this series) makes this split easy. `app.ts` produces a configured Fastify instance with no I/O; `server.ts` is the entry point that wires it up. To split the server, you write a different entry point that wires up only the pieces you want, and you have a smaller deployable. The structural decision I made for *testability* turns out to be the same one I'd want for *deployability*.

**The single change-stream consumer.** One server, one cursor, one fan-out. At scale you'd want multiple WebSocket fan-out servers (so you can horizontally scale connection counts). Each one would need its own change stream cursor — and they'd all be reading the same oplog, broadcasting to disjoint sets of clients. The dashboard's "events per second" rate would be the same; the *connection capacity* would scale linearly with the number of fan-out servers.

The thing this requires is a sticky-routing layer: each WebSocket client connects to a specific fan-out server and stays there. Anything trying to broadcast across all clients has to route through every fan-out server, which is a much more complex topology than the current one. This is the kind of thing where the patterns get *new* — load balancing, sticky sessions, broadcast meshes — and not just "more of the same."

## What's missing for production

These are the gaps I'd close if EventHorizon were going to take real traffic.

**Authentication and authorisation.** There is none. The HTTP endpoint accepts any well-formed payload from any source. The WebSocket dashboard has no notion of user. In production this is the first thing you'd add — JWT or session auth on HTTP, per-user filtering on the WebSocket. None of it is hard; all of it is missing.

**Multi-tenancy.** Every event belongs to "the system." There's no tenant ID, no per-tenant isolation in storage, no per-tenant queue. To make this multi-tenant you'd add a tenant identifier to `AppEvent`, partition the storage (per-tenant collection or sharded by tenant), and add per-tenant routing in the queue topology. The schema-as-contract pattern makes the *shape* change easy; the operational implications are larger.

**Rate limiting and quotas.** A single tenant or attacker could submit events faster than the worker pool can drain them. The queue depth would climb until you ran out of disk. Production needs ingress rate limits (by IP, by API key, by tenant) and back-pressure signalling all the way to the producer.

**Observability beyond a dashboard.** EventHorizon has a beautiful live dashboard. It doesn't have *historical* observability — Prometheus metrics, distributed traces, structured logs flowing to a log aggregator. For one developer running it on their laptop, the dashboard is enough. For an operator running it in production, it isn't.

The interesting bit is that the metrics module already has *most* of the data structured the way Prometheus would want it. `totalProcessed`, `failedCount`, `queueDepth`, `processingRatePerSec` — these are textbook Prometheus metric names. Wiring them up to a `/metrics` endpoint is a 50-line change. The hard work was building the rolling-window aggregation; the export format is the easy part.

**Deployment infrastructure.** A `docker-compose.yml` for development is not a production deployment. Real production needs a Kubernetes manifest (or Nomad, or whatever the org uses), a CI/CD pipeline that builds and tests on every commit, secrets management, environment promotion. This is all conventional work — it doesn't change the application architecture — but the application doesn't run in production until it's done.

## What I'd build differently if I started over

A short list, with regret levels:

**ADRs from day one.** I started writing ADRs around phase 4. The first three are retroactive. They're *fine*, but they're a little less vivid than the ones written on the day. Cost of writing an ADR while a decision is fresh: 20 minutes. Cost of reconstructing one later: more like an hour, with worse fidelity. The first ADR should have been *"we will write ADRs."*

**The App Factory split from day one.** I had a single-file server for weeks before extracting the factory. The refactor was fast, but the period before it was full of small, persistent annoyances (the test crashes, the import-time I/O, the inability to load the routes module without standing up infrastructure). Splitting on day one is free. Doing it later is cheap but not free.

**A `not-automated` section in TESTING.md from day one.** I added the gap-naming discipline (testing post) late. Before that, the gaps existed but were implicit. Naming them earlier would have made the project's testing posture more legible without changing the actual test count.

**The metrics module a bit earlier.** I built the metrics interval after the storage and observation planes were already running. It would have been useful to have *during* the build of those planes — every "is the system actually working?" question I asked myself would have been easier to answer with a stats dashboard already in place. Build the diagnostics tool early; you'll use it more than you think.

## The patterns I'd reach for in any future project

This is the takeaway list, the part that survives the specific stack and the specific learning context.

1. **One-direction data flow.** Name your stages, draw arrows between them, refuse to draw any others. If a feature wants to draw a backwards arrow, the feature is wrong, not the rule.

2. **At-least-once + idempotent receiver.** Anywhere there's a delivery contract you don't fully control (queue, network, async work), assume the message will arrive twice. Build the receiver to absorb duplicates. Use a unique constraint as the load-bearing mechanism. Catch *only* the duplicate-key error; let everything else propagate.

3. **Schema-as-contract with `z.infer<>`-style derivation.** A type and its validator should be the same declaration. Hand-written types alongside hand-written validators are a guaranteed long-term bug.

4. **Application-level retry with bounded count and dead-letter.** Don't trust the broker's `requeue=true`. Track retries on the message, cap the count, route exhausted retries to a DLQ. Make sure someone (or some metric) looks at the DLQ.

5. **Append-only storage where possible.** "We can mutate later if needed" tends to mean "we mutated things and now we can't reason about state." Write once. If you need to "update," append a new record with a reference. Mutation is a privilege you should not grant lightly.

6. **Graceful shutdown as the reverse data flow, plus an explicit exit.** Tear down outermost-first, drain at every layer, force-exit at the end. The order is dictated by the dependency graph; the rigour comes from writing the order down somewhere people will read it.

7. **App factory split.** The file you `node X.js` and the file you `import Y from "X.js"` should never be the same file. Construction is one job. Startup is another. Don't merge them.

8. **ADRs as the durable memory of decisions.** Numbered, dated, with Context/Decision/Rationale/Alternatives/Consequences. Cheap to write at the moment of decision; expensive to reconstruct later; invaluable when future you (or future a teammate) wants to know *why*.

9. **Name the gaps in your test coverage.** Untested code is fine. Untested code that's *not labelled* as such is a debt.

10. **Standing context for AI assistants is leverage.** Hard invariants written down once stop being re-explained every session. The discipline is the same as writing good ADRs: capture the reasoning durably so each consumer (human or AI) doesn't have to reconstruct it.

Ten patterns. Seven of them I knew before this project, but I knew them as *names*; I now know them as muscle memory. Three of them (the ADR habit, the gap-naming, the standing-context discipline) I either invented or stole during this project, and they're the ones I'm taking forward most aggressively into the next one.

## A closing note

EventHorizon was a learning project. The domain (telemetry events) was scaffolding; the plumbing was the point. I started it because I wanted to *internalise* the patterns of message-driven backends, not just be able to describe them. Eleven blog posts later, I think the internalisation worked.

The funny thing about writing a series of blog posts about a learning project is that the writing itself becomes part of the learning. Several of these posts forced me to articulate things I'd been treating as tacit knowledge. The "seven-step shutdown" post made me realise that I had been keeping the order in my head; writing it out exposed two ambiguities I then went back and fixed in the code. The "three strikes" post made me notice that I had no real plan for what to do with the dead-letter queue once messages started accumulating there.

The blog posts were the second test suite. Not in the sense of verifying behaviour — that's what the unit tests are for — but in the sense of verifying *understanding*. If you can't write a clean post about why a pattern is correct, you don't understand it well enough to defend it under pressure. Writing was the pressure.

Thanks for reading the series. The code is in the repo if you want to look at it; the LEARNING_LOG has the flashcard-format study notes if you want the same content as Q&A pairs; the ADRs have the design-decision trail. Everything I wanted to leave behind from this project is on the file system, and that's, by design, the durable artifact.

Next project starts with one assistant, one context file, and an ADR-001 titled *"We will write ADRs."* The cycle continues.
