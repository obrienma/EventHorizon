---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-18, observability, otel]
cross-ref: observability
---
Phase 18 exports the in-app dashboard's pipeline-internal signals as OTel instruments so Grafana can read them. `events.processed` is a {{c1::Counter}} incremented on the worker's successful-ack path, rendered to Prometheus as `events_processed_total{event_type="..."}`; `eventhorizon.change_stream.lag` is an {{c2::ObservableGauge}} whose callback reports the latest `lastChangeStreamLagMs`. Both reuse the `MeterProvider` that `NodeSDK` auto-configures from {{c3::OTEL_* env vars}} — no new pipeline wiring.

Extra: EventHorizon · Phase 18 · Pattern: Promote Already-Sanctioned Metric-Shaped Signals to Exported OTel Instruments
See: docs/journal.md#phase-18-custom-otel-metrics

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-18, observability, design]
cross-ref: observability
---
Q: ADR 0016 names `events_by_type_total{type="sensor"}` as a counter you should *not* create (use a span attribute). Why does Phase 18's `events_processed_total{event_type}` not violate that ADR?

A: Two reasons recorded in ADR 0017. (1) The label is a closed three-value enum (`pipeline|sensor|app`) fixed by the discriminated union — no cardinality growth, which was 0016's actual objection to counters. (2) The signal is a sampling-independent throughput/SLO rate; it cannot be derived from sampled traces without dividing by an unknown sampling ratio. The "alert vs. analyze" test still holds — per-source/per-id breakdowns stay as span attributes; only the bounded per-type *rate* becomes a counter.

Extra: EventHorizon · Phase 18 · Challenge: Reconciling a New Counter With ADR 0016
See: docs/journal.md#phase-18-custom-otel-metrics

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-18, observability, mongodb]
cross-ref: observability
---
Q: Why is change-stream lag an ObservableGauge rather than a Counter or a per-insert measurement — and why can't it be a span attribute instead?

A: Lag is a point-in-time *level*, not an event to count, so an async gauge polled on the export interval is the right shape (emitting on every insert would be a histogram's job). It cannot be a span attribute because the change stream is a background watcher with no request span to attach to — which is also why it had no Grafana representation before this phase.

Extra: EventHorizon · Phase 18 · Pattern / Challenge
See: docs/journal.md#phase-18-custom-otel-metrics

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-18, observability, verification]
cross-ref: observability
---
`queueDepth` is deliberately {{c1::not}} exported as an EventHorizon metric — it belongs to {{c2::RabbitMQ's own Prometheus exporter}}, avoiding a second source of truth. The two metrics that *were* added were live-validated by querying Prometheus directly: `events_processed_total` split correctly by `event_type` and the lag gauge read {{c3::0}} (expected for a local dev replica set), both labeled `exported_job="event-horizon"`.

Extra: EventHorizon · Phase 18 · Decision: Live-Validate Custom Metrics Rather Than Trust the Wiring
See: docs/journal.md#phase-18-custom-otel-metrics

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-18, observability, design]
cross-ref: observability
---
Q: On the dead-letter path a parse failure produced no typed event, so `events.failed` has no `event.type` to label by. Why use a fixed `event_type="unknown"` instead of the message's routing key or id?

A: To keep the label set *closed*. `event.type` is a bounded three-value enum; adding one fixed `"unknown"` keeps it at four values. The routing key or message id are unbounded dimensions — using them would reintroduce exactly the cardinality-explosion risk ADR 0016/0017 reserve for span attributes, not counter labels. `events_failed_total` is also notable as the realization of the "dead-letter rate" ADR 0016 already reserved as a counter — so it needs no reconciliation.

Extra: EventHorizon · Phase 18 · Anti-Pattern Avoided: Inventing a High-Cardinality Counter Label
See: docs/journal.md#phase-18-custom-otel-metrics
