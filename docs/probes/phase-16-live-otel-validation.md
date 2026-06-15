---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-16, opentelemetry, observability]
cross-ref: observability
---
`span?.setAttributes({ "payload.size_bytes": Buffer.byteLength(request.body as string) })` — when `span` is `{{c1::undefined}}`, optional chaining short-circuits the entire expression, including evaluation of its {{c2::arguments}}. `Buffer.byteLength(...)` is never invoked, never throws.

Extra: EventHorizon · Phase 16 · Pattern: Optional Chaining Short-Circuits Its Entire Argument Tree
See: docs/journal.md#phase-16-live-otel-validation

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-16, opentelemetry, testing, observability]
cross-ref: observability
---
Q: A test suite passes 44/44, yet under `npm run dev` every `POST /events` returns 500. The buggy line is `span?.setAttributes({ "payload.size_bytes": Buffer.byteLength(request.body as string) })`. Why doesn't the test suite catch this?

A: In `app.inject()` tests there's no live OTel SDK, so `trace.getActiveSpan()` returns `undefined` and `span?.setAttributes(...)` short-circuits before evaluating `Buffer.byteLength(request.body as string)` — the throwing expression never runs. Under real HTTP auto-instrumentation, `span` is a real object, the argument is evaluated, and `Buffer.byteLength()` throws `ERR_INVALID_ARG_TYPE` because `request.body` is a parsed object, not a string.

Extra: EventHorizon · Phase 16 · Challenge: A Fully-Passing Test Suite Coexisted With a 500 on Every Real Request
See: docs/journal.md#phase-16-live-otel-validation

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-16, decision, observability]
cross-ref: observability
---
The `Buffer.byteLength` bug was found while validating Phase 15's definition of done against a live stack — a {{c1::verification}} activity, not new feature work. It was fixed immediately rather than deferred, because a non-functional ingest endpoint made every other verification step ({{c2::trace propagation, log correlation, metrics scrape}}) untestable.

Extra: EventHorizon · Phase 16 · Decision: Fix Live-Discovered Bugs Immediately, Even Mid-Validation-Pass
See: docs/journal.md#phase-16-live-otel-validation

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-16, grafana, observability]
cross-ref: observability
---
Q: The new "EventHorizon Service" Grafana dashboard required zero EventHorizon code changes. What metrics does it use, and why doesn't it implement the migration plan's Phase 5 TraceQL/wide-span dashboard vision?

A: It uses metrics `auto-instrumentations-node` already exports via OTLP — `http_server_duration_milliseconds_*` (RED metrics), `db_client_connections_usage`, `nodejs_eventloop_delay_*`, and `v8js_memory_heap_used_bytes` (Node.js runtime health). The Phase 5 vision is TraceQL panels over wide-span business attributes (`event.type`, `classification`) — deferred to full Phase 5, per the plan's anti-goal against pre-aggregating business attributes into Prometheus counters. This dashboard answers "is the service healthy," not "what is the service doing."

Extra: EventHorizon · Phase 16 · Decision: Service Dashboard Built From Existing Auto-Instrumentation Metrics — No New Instrumentation Code
See: docs/journal.md#phase-16-live-otel-validation
