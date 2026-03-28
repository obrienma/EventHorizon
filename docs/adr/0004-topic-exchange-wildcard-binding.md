# ADR 0004 — Topic Exchange with `events.#` Wildcard Binding

**Status:** Accepted

---

## Context

RabbitMQ requires a decision about exchange type when designing the message topology. Three exchange types are available: direct (exact routing key match), fanout (deliver to all bound queues), and topic (pattern-matched routing key). A fourth — headers exchange — exists but is rarely used.

The pipeline ingests three event types: `pipeline`, `sensor`, and `app`. The current requirement is to route all events to a single work queue. A future requirement — routing specific event types to dedicated consumers — is likely.

## Decision

Declare a **topic exchange** named `events`. Bind the work queue (`events.work`) with the wildcard pattern `events.#`. Publish events with routing keys `events.pipeline`, `events.sensor`, and `events.app`.

## Rationale

A topic exchange with `events.#` is functionally equivalent to a fanout for the current single-consumer case, but it preserves the ability to add type-specific consumers later without changing the topology. A consumer that only needs sensor data binds `events.sensor`; a consumer for all events uses `events.#`. No re-architecture needed.

A direct exchange with a single fixed routing key would work today but would require all publishers and consumers to agree on a new routing scheme if specialised consumers were added. A fanout would be even more restrictive — it delivers to all bound queues regardless of content, making selective consumption impossible.

The per-event-type routing key also makes the message's origin readable directly from the RabbitMQ Management UI without opening the message payload.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Direct exchange | Simple; explicit | Requires exact key match; no wildcards; poor extensibility |
| Fanout exchange | Simplest setup; zero routing logic | Delivers to all queues unconditionally; cannot support selective consumers |
| Default (nameless) exchange | No declaration needed | Tightly coupled to queue names; no routing expressivity |

## Consequences

- All publishers must use structured routing keys following the pattern `events.<type>`.
- Adding a new event type requires adding a new routing key constant — no topology change.
- Adding a type-specific consumer requires only a new queue binding, not touching the exchange or existing consumers.
- Topology is declared idempotently on startup (`{ durable: true }` arguments must be consistent across restarts — changing them requires deleting and re-declaring the exchange).
