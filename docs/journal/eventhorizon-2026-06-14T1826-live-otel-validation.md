---
id: eventhorizon-2026-06-14T1826-live-otel-validation
repo: eventhorizon
title: "Live OTel Validation"
date: 2026-06-14
phase: 16
tags: [opentelemetry, optional-chaining, testing, grafana, observability, live-verification]
cross_ref: observability
cross_ref_id: eventhorizon-2026-06-14T1826-live-otel-validation
files: [src/ingestion/event.routes.ts]
---

### Pattern: Optional Chaining Short-Circuits Its Entire Argument Tree

`event.routes.ts` called `span?.setAttributes({ "payload.size_bytes": Buffer.byteLength(request.body as string) })`. `request.body` is a parsed object (Fastify's JSON body parser), not a string, so `Buffer.byteLength()` throws `ERR_INVALID_ARG_TYPE` on every call. Yet `npm test` (44/44) never caught it. The reason: `span?.setAttributes(...)` is an optional call — when `span` is `undefined`, the optional-chaining operator short-circuits the entire expression, including evaluation of its arguments, so `Buffer.byteLength(...)` is never invoked and never throws. The fix is `JSON.stringify(request.body)` before measuring byte length.

### Challenge: A Fully-Passing Test Suite Coexisted With a 500 on Every Real Request

In `app.inject()` tests there is no live OTel SDK and no active span — `trace.getActiveSpan()` returns `undefined` (Phase 15's Noop fallback), so `span?.setAttributes(...)` never evaluates its buggy argument. Under `npm run dev` with the real `NodeSDK` running and Fastify's HTTP auto-instrumentation creating a real SERVER span for every request, the same line threw on 100% of `POST /events` calls, returning 500 — the seed producer reported `sent: 0, failed: 8`. The bug was invisible to the test suite by construction, not by oversight, and was discovered only by running the full pipeline against a live OTel Collector (`rhizome-observability`) and watching real traffic 500 out.

### Decision: Fix Live-Discovered Bugs Immediately, Even Mid-Validation-Pass

The bug surfaced while validating Phase 15's "definition of done" against the live `rhizome-observability` stack — a verification activity, not new feature work. It was fixed on the spot (`a9e2e4a`) rather than logged as a follow-up, because a non-functional ingest endpoint made every other verification step (trace propagation, log correlation, metrics scrape) untestable. Phase boundaries are for planned work; a bug that blocks the thing currently being validated gets fixed on discovery.

### Decision: Service Dashboard Built From Existing Auto-Instrumentation Metrics — No New Instrumentation Code

The "EventHorizon Service" Grafana dashboard (`rhizome-observability/grafana/provisioning/dashboards/eventhorizon-service.json`) — request rate by status code, 5xx error rate, p50/p95/p99 latency, MongoDB connection pool, Node.js event-loop lag, V8 heap, and trace-correlated logs — uses only metrics `auto-instrumentations-node` already exports (`http_server_duration_milliseconds_*`, `db_client_connections_usage`, `nodejs_eventloop_delay_*`, `v8js_memory_heap_used_bytes`). Zero EventHorizon code changes were needed. This is deliberately a Prometheus/RED dashboard, not the TraceQL/wide-span business dashboard the migration plan's Phase 5 envisions (queries over `event.type`/`classification` attributes) — that remains deferred to full Phase 5, per the plan's anti-goal against pre-aggregating business attributes into Prometheus counters. This dashboard answers "is the service healthy"; "what is the service doing" is answered by the Tempo trace waterfall (`Explore → Tempo → {resource.service.name="event-horizon"}`), not by this dashboard.
