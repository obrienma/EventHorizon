# ADR 0014 — Integration Test Strategy for the Observation Plane

**Status:** Accepted

---

## Context

The current test suite covers all pure-logic and I/O-boundary layers with unit tests (Vitest + `mongodb-memory-server` for repository tests, Fastify `inject()` for route tests). Three integration-layer concerns are explicitly marked "not automated" in `docs/TESTING.md`:

- MongoDB change stream behaviour (needs a replica set)
- WebSocket broadcast sequencing
- Graceful shutdown ordering

The question is whether to write integration tests for these layers, and if so, in what order.

---

## Decision

Pursue integration tests for WebSocket and change streams as explicit learning phases. Defer graceful shutdown integration tests indefinitely.

**Recommended order:**

1. **WebSocket integration tests first.** Fastify exposes first-class WebSocket test support; a `ws` client can connect to a live test server and assert on message ordering and connection lifecycle. No external infrastructure required.

2. **Change stream integration tests second.** `mongodb-memory-server` supports replica set mode, which enables oplog and change stream tests. The setup overhead is non-trivial but the test logic itself is straightforward once the replica set is initialised. This is where resume token round-trips and recovery behaviour can be verified.

3. **Graceful shutdown — test the pieces, not the sequence.** Signal-based full-shutdown integration tests are fragile in CI (timing-dependent, hard to assert atomically). The invariants that matter — ack-after-write, close order — are better verified by unit-testing each step in isolation than by orchestrating a full `SIGTERM` scenario.

---

## Consequences

- The test suite gains coverage of the two highest-risk integration points (WS message delivery, change stream recovery) while avoiding a class of slow, flaky shutdown tests.
- Change stream tests require `mongodb-memory-server` to be initialised with `{ replicaSet: true }` — this adds ~1–2s to test startup and must be isolated to its own Vitest project or describe block to avoid slowing unrelated tests.
- Graceful shutdown correctness remains a documentation and code-review concern, not a test-suite concern.
