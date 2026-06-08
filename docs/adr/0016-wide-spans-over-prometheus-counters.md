# ADR 0016 — Wide Span Attributes Over Pre-Aggregated Prometheus Counters

**Status:** Accepted

---

## Context

Phase 15 added OpenTelemetry tracing alongside the existing in-memory metrics in `observation/metrics.ts` (`totalProcessed`, `failedCount`, `queueDepth`, `processingRatePerSec`, `eventTypeDistribution`). Both systems can answer overlapping questions — e.g. "how many events were classified as critical?" can be a Prometheus counter with a `classification` label, or a span attribute on every `event.process` span.

Going forward, every new analytical signal (classification breakdowns, per-source error rates, lag distributions, subscriber counts, etc.) needs a default home. Without a stated rule, each addition becomes an ad hoc choice between "add a label to a counter" and "add an attribute to a span" — and the two approaches have materially different failure modes once the system is running.

## Decision

Default new instrumentation to **span attributes**, queried via TraceQL. Reserve **Prometheus counters/gauges** for signals that must drive threshold-based alerts regardless of trace sampling — currently: `queueDepth` (warning/critical thresholds) and dead-letter rate.

The question to ask when adding a new signal: *"Does this need to fire an alert independent of whether any particular trace was sampled and retained?"* If yes → counter/gauge in `metrics.ts`. If no → span attribute.

## Rationale

A Prometheus counter commits to its aggregation shape — and its label set — at write time. Once `events_by_type_total{type="sensor"}` exists, you can ask "how many sensor events total," but you cannot retroactively ask "which sensor events came from source X," because `source` was never a label. Adding it later means choosing, in advance, every dimension you might ever want to slice by — and over-choosing causes cardinality explosions that take down the metrics backend.

Span attributes carry no such commitment. They are stored raw, per-span, and queried in arbitrary combination after the fact via TraceQL — `{ classification="critical" && event.source="sensor-7" }` works whether or not anyone anticipated that exact combination when the span was created. The cost is that TraceQL requires a running Tempo instance with the relevant traces sampled and retained; Prometheus counters are always-on and cheap to scrape regardless of trace volume.

This is why the split is drawn at *alerting vs. analysis*: an alert must fire reliably even if 99% of traces are dropped by the sampler, so it needs an always-on counter. An analytical question — "show me everything that looks like X" — benefits from the raw, unaggregated record that only spans provide.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Pre-aggregate everything into labelled Prometheus counters | Familiar PromQL; queryable without a trace backend running | Commits to a label set at write time; cardinality risk grows with every new label; can't ask new questions of old data |
| Put everything on spans, including alerting signals | Single source of truth; maximum query flexibility | Alerting on sampled trace data is fragile — a dropped/unsampled trace silently drops the alert signal; adds a Tempo dependency to the always-on alerting path |
| Hybrid — counters for alerting, attributes for analysis (chosen) | Each signal uses the backend suited to its access pattern and reliability requirement | Two systems to reason about; requires applying the "alert vs. analyze" test consistently as new signals are added |

## Consequences

- `metrics.ts`'s existing counters (`totalProcessed`, `failedCount`, `queueDepth`, `processingRatePerSec`, `eventTypeDistribution`) stay as in-memory/Prometheus-shaped signals — they are not migrated to spans, because `queueDepth` already drives the dashboard's warning/critical status and the others are cheap to keep alongside it.
- New "break down X by Y" questions should not require an instrumentation change if X and Y are already span attributes — only a TraceQL query changes.
- A reviewer adding a new metric should be able to point at this ADR and answer "alerting or analysis?" before deciding where it lives.
