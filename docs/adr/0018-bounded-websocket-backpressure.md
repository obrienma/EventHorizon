# ADR 0018 — Bounded WebSocket Backpressure, Accepted At-Most-Once Delivery

**Status:** Accepted

**Date:** 2026-07-04

---

## Context

Synapse-L4 ingests telemetry from EventHorizon as a WebSocket client (`src/clients/eventhorizon.py`), subscribed to `/ws`. Two things about that channel were flagged as concerns:

1. **No backpressure on EventHorizon's side.** `broadcast()` (`wsServer.ts`) checks `readyState` before calling `socket.send()`, but never `bufferedAmount`. If a client's read loop stalls, EventHorizon keeps buffering outgoing bytes in process memory with no ceiling.
2. **No delivery guarantee across disconnects.** The WS plane is explicitly designed (ADR-0007, EventHorizon) for best-effort delivery to browser dashboards — no replay, no resume token. Anything broadcast while Synapse-L4 is disconnected is gone.

Two alternatives were considered to solve (2): have Synapse-L4 consume EventHorizon's MongoDB collection directly via change stream (reusing EventHorizon's own resume-token pattern), or have it consume from a new RabbitMQ binding off EventHorizon's existing exchange. Both would give durable, replay-safe delivery. Neither is being adopted, for two separate reasons — one architectural, one empirical.

**Architectural reason:** there are two different things "coupling" can mean here, and they shouldn't be conflated. Synapse-L4 being tightly bound to a *contract* — the shape of a telemetry event it consumes, the shape of the `Axiom` it produces for Sentinel — is correct and intentional; that's the sidecar's entire job. Synapse-L4 reaching into EventHorizon's *internal* MongoDB collection, keyed to its private document schema, and writing into its checkpoint collection is a different kind of coupling: coupling to an implementation detail that was never exposed as an interface. Two services reading and writing the same database directly aren't really separable anymore, regardless of how many repos they live in. The Mongo-direct approach solves the durability problem by trading up to this worse kind of coupling. RabbitMQ avoids that specific problem (a queue is an explicit interface, not a shared internal) but adds an operational dependency to a service whose entire purpose is being a lightweight validation sidecar.

**Empirical reason, which turned out to matter more:** the durability concern was motivated by `extract()`'s LLM fallback taking 20–35s (or ~620s cold) per call, on the assumption that this sits on the critical path for real traffic. It doesn't. Tracing the actual flow:

- EventHorizon's seed producer (`src/seed/producer.ts`) only ever emits `pipeline`, `sensor`, and `app` events. Its `--error-rate` flag sends events with a malformed `id`, but those are rejected with a 422 at the ingestion route — before queueing, before persistence. They never become a `StoredEvent` and never reach Synapse-L4 at all.
- `classify.ts` is an exhaustive switch over those three event types; every branch returns a `classification` of `"normal"`, `"warning"`, or `"critical"`. There is no other outcome.
- Synapse-L4's `_try_direct_extraction` (Shape 2) deterministically maps exactly those three classifications, with no LLM call.

So for anything this system's own demo traffic actually generates, the LLM fallback is unreachable — it exists for genuine defensive robustness, but is exercised in practice only by Synapse-L4's own test fixtures, which hand-craft unstructured payloads specifically to hit that branch. The slow path isn't routine; it isn't on the demo's critical path at all. Backpressure from LLM latency isn't a live problem for the traffic this system produces.

---

## Decision

**Fix the unbounded-memory bug in `broadcast()`. Keep Synapse-L4 as a WebSocket subscriber. Accept at-most-once delivery as a documented limitation — the same posture EventHorizon's own dashboard already accepts.**

Concretely:

1. **EventHorizon** (`wsServer.ts`): add a `bufferedAmount` threshold check in `broadcast()`. If a client's buffer exceeds the threshold, skip sending to it (log it) rather than queuing indefinitely; optionally close the connection above a higher threshold, mirroring the bounded-backpressure philosophy `WORKER_PREFETCH` already applies to the RabbitMQ layer, applied here to the WS layer instead.
2. **Synapse-L4**: no changes. Its existing design — a bounded `asyncio.Queue` decoupling the WS read loop from the worker pool, exponential-backoff reconnect — was already correct for what it needs to do. It stays a pure protocol consumer with no storage coupling to EventHorizon and no new dependency.
3. **Documentation**: `docs/TESTING.md` or `docs/ARCHITECTURE.md` in Synapse-L4 gets a short note stating the at-most-once limitation explicitly, so it's a stated design decision rather than an implicit gap discovered later.

---

## Rationale

1. **Fixing `broadcast()` addresses a real bug regardless of traffic volume.** Unbounded memory growth on a slow consumer is worth fixing on its own terms — it's a small, contained change, entirely inside EventHorizon, and doesn't require deciding anything about Synapse-L4's durability needs first.
2. **The durability problem this was meant to solve isn't actually occurring.** Both alternatives (Mongo-direct, RabbitMQ) pay a real cost — worse coupling, or a new dependency — to solve a backpressure scenario that doesn't happen with this system's actual traffic shape. Paying that cost for a hypothetical is exactly the kind of premature infrastructure "wait until it hurts" exists to avoid.
3. **Contract-coupling stays tight where it should.** Synapse-L4 remains tightly bound to the telemetry event contract and the `Axiom` contract — which is the right kind of tight coupling for a validation sidecar — without becoming coupled to EventHorizon's storage internals.
4. **The trigger for revisiting this is well-defined, not vague.** If the LLM fallback ever becomes routine — e.g. EventHorizon starts emitting genuinely unstructured telemetry as normal traffic, not an edge case — durability stops being hypothetical and this decision should be reopened. At that point RabbitMQ, not Mongo-direct, is the one to reach for, since it gets durability without the internals-coupling cost.

---

## Alternatives Rejected

**MongoDB change stream consumer, reusing EventHorizon's checkpoint pattern.** Rejected — gets durability at the cost of coupling Synapse-L4 to EventHorizon's private document schema and giving it write access to EventHorizon's own checkpoint collection. That's the shared-database anti-pattern in practice, even when the mechanism being reused (resume tokens) is well-designed. Also unnecessary given the empirical finding above — there's no delivery gap in practice worth paying this cost to close.

**RabbitMQ competing-consumer queue off EventHorizon's existing exchange.** Rejected for now — avoids the internals-coupling problem (a queue is a real interface) but adds an AMQP dependency to a service whose job is lightweight validation, for a durability guarantee the current traffic profile doesn't need. Worth revisiting if the trigger in Rationale #4 occurs; not before.

**Leave `broadcast()` as-is.** Rejected — the unbounded-buffer bug is real and cheap to fix independent of the durability question; no reason to leave it unfixed just because it isn't the routine failure mode today.

---

## Consequences

- `EventHorizon`: `wsServer.ts`'s `broadcast()` gains a `bufferedAmount` check. No new dependencies.
- `synapse-l4`: no code changes. Its existing WS client, queue-based decoupling, and reconnect logic are confirmed correct and left in place.
- At-most-once delivery is now a stated, accepted limitation for Synapse-L4's telemetry ingestion, not an implicit gap.
- No change to ADR-0008 (live LLM test tier) — that ADR's reasoning about the LLM path's latency stands; this ADR just establishes that the LLM path isn't on the critical path for real traffic, which is why its latency doesn't drive a durability requirement.
- If EventHorizon's traffic profile changes such that unstructured telemetry becomes routine rather than an edge case, reopen this decision with RabbitMQ as the preferred durable option over Mongo-direct consumption.
