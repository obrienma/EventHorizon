# ADR 0017 — Custom OTel Metrics for Pipeline-Internal Signals

**Status:** Accepted

**Refines:** [ADR 0016 — Wide Span Attributes Over Pre-Aggregated Prometheus Counters](0016-wide-spans-over-prometheus-counters.md)

---

## Context

The native in-app dashboard (Observation Plane → WebSocket `StatsPayload`) exposes three pipeline-internal signals that the Grafana "EventHorizon Service" dashboard cannot see, because that dashboard is built entirely from HTTP and Node.js runtime auto-instrumentation: `queueDepth`, `changeStreamLagMs`, and `eventTypeDistribution`. To let the shared `rhizome-observability` stack (Prometheus/Grafana) trend and alert on pipeline health — not just ingest-side RED metrics — these signals need a metrics-backend representation.

ADR 0016 already governs where new analytical signals live: default to span attributes, reserve Prometheus counters/gauges for signals that "must drive threshold-based alerts regardless of trace sampling" (currently `queueDepth` and dead-letter rate). Crucially, ADR 0016 line 21 uses `events_by_type_total{type="sensor"}` as its *cautionary example* of a counter one should not create — while line 37 simultaneously keeps `eventTypeDistribution` as a sanctioned "Prometheus-shaped signal." Phase 18 therefore needs an explicit rule for which pipeline signals become exported metrics, and how that squares with 0016.

## Decision

Export two pipeline-internal signals as custom OTel instruments, reusing the `MeterProvider` that `NodeSDK` auto-configures from `OTEL_*` env vars:

1. **`events.processed`** — a `Counter` incremented on the worker's successful-ack path, labeled by `event.type`. Renders to Prometheus as `events_processed_total{event_type="pipeline|sensor|app"}`.
2. **`events.failed`** — a companion `Counter` incremented on the worker's dead-letter path (after retries are exhausted), labeled by `event.type` with a bounded `"unknown"` fallback for parse failures that produced no typed event. Renders as `events_failed_total{event_type="..."}`. This is the realization of the "dead-letter rate" ADR 0016 already reserved as a counter, and is the async-failure signal the HTTP 5xx panel cannot see.
3. **`eventhorizon.change_stream.lag`** — an `ObservableGauge` (unit `ms`) whose callback reports the latest `lastChangeStreamLagMs`. Renders as `eventhorizon_change_stream_lag_milliseconds`.

`queueDepth` is **not** added as an EventHorizon metric — it is sourced from RabbitMQ's own Prometheus exporter (recommended for the observability repo), so the broker remains the single source of truth for its own queue state.

This *refines* ADR 0016 rather than overriding it: the "alert vs. analyze" test still decides where a signal lives. Phase 18 adds two clarifications 0016 left implicit:

- **Sampling-independence covers rates and levels, not just thresholds.** A throughput rate (`rate(events_processed_total[…])`) or a lag SLO cannot be derived from sampled traces without dividing by an unknown sampling ratio. Such signals must be always-on instruments, exactly as 0016 reserves for alerting — so per-type processed rate and change-stream lag join `queueDepth` and dead-letter rate in the reserved counter/gauge set.
- **Counter labels are restricted to closed, bounded enums.** `event.type` is a fixed three-value set from the discriminated union, so it carries none of the cardinality risk 0016 warns about. Open-ended dimensions (`source`, `id`) stay span-only.

## Rationale

ADR 0016's objection to counters is cardinality commitment at write time. `event.type`'s value space is closed and tiny (3), so labeling by it is safe; this is the same signal 0016 already kept as `eventTypeDistribution`, now promoted from an in-memory/WebSocket-only value to an exported instrument so Grafana — not only the in-app dashboard — can read it.

Change-stream lag additionally *has no span to attach to*: the change stream is a background watcher, not part of any request trace, so the span-attribute default in 0016 is not even available. A gauge is both the correct shape (a point-in-time level, polled on the export interval) and the only option.

Reusing the existing `MeterProvider` (no explicit `PeriodicExportingMetricReader`) keeps the wiring identical to the auto-instrumentation already proven to reach Prometheus — verified live (see Consequences).

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| Keep all three signals WebSocket-only (status quo) | No new code; ADR 0016 untouched | Grafana cannot trend/alert on pipeline health; signals vanish on dashboard disconnect; no history |
| Export `queueDepth` from EventHorizon too | One code path for all three | Duplicates RabbitMQ's own metric — two sources of truth that can disagree |
| Derive per-type throughput from Tempo traces (pure 0016) | No new instrument | Sampled data undercounts; unusable as a rate SLO; couples an always-on signal to the trace backend |
| Export two pipeline signals as instruments; queue depth from broker exporter (chosen) | Each signal uses the backend suited to its access pattern; closed label set; no duplicate truth | Two more instruments to maintain; requires applying the refined 0016 test |

## Consequences

- `src/processing/worker.ts` and `src/observation/metrics.ts` each obtain a meter via `metrics.getMeter("eventhorizon")`; no change to `tracing.ts` was needed.
- Grafana panels can now use `sum(rate(events_processed_total[1m])) by (event_type)` for per-type throughput and `eventhorizon_change_stream_lag_milliseconds` for delivery lag (see the observability-repo recommendations).
- Live-validated against `rhizome-observability`: 60 seeded events yielded `events_processed_total` of 25/35/36 by `event_type` and a lag gauge of `0` (expected for a local dev replica set), both labeled `exported_job="event-horizon"`. The contingency `PeriodicExportingMetricReader` was confirmed unnecessary. `events_failed_total` shares the identical proven `Counter` code path but emits no series until a dead-letter occurs (a counter with no measurement is not exported), and was not exercised in this run since the seeded traffic produced no processing failures.
- A reviewer adding a future pipeline metric applies the refined test: alert/SLO + sampling-independent + bounded label set → instrument; otherwise → span attribute.
