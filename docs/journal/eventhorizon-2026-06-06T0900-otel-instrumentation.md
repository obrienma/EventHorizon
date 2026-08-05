---
id: eventhorizon-2026-06-06T0900-otel-instrumentation
repo: eventhorizon
title: "OTel Instrumentation"
date: 2026-06-06
phase: 15
tags: [opentelemetry, esm, traceql, wide-spans, context-propagation, rabbitmq, amqplib, observability]
cross_ref: observability
cross_ref_id: eventhorizon-2026-06-06T0900-otel-instrumentation
files: [src/observation/tracing.ts, src/server.ts, src/processing/worker.ts, src/processing/queue.ts, src/ingestion/event.routes.ts, src/observation/wsServer.ts, .env.example, docs/adr/0015-otel-sdk-bootstrap-esm-entry-points.md, docs/adr/0016-wide-spans-over-prometheus-counters.md]
---

### Pattern: First-Import SDK Bootstrap (ESM)

`import "./observation/tracing.js"` appears as the first line of each entry point rather than being loaded via an `--import` flag, because ESM module evaluation is depth-first, left-to-right: the first import in a module's static import list is fully evaluated before any subsequent import. Placing `tracing.js` first in `server.ts` guarantees `sdk.start()` completes before `app.ts`, `amqplib`, or MongoDB are evaluated — a spec-level guarantee, not a tsx or Node implementation detail. The `--import` flag approach works but moves bootstrap responsibility to npm scripts, an easy place to miss when adding a new entry point. This doesn't break the test suite because Vitest imports test files and their transitive dependencies directly, never through `server.ts` or `worker.ts` — the `NodeSDK` never calls `sdk.start()` in tests, and `@opentelemetry/api` falls back to a `NoopTracerProvider` when no SDK is registered: `trace.getActiveSpan()` returns `undefined`, `propagation.inject()` is a no-op, and `context.with()` just calls the callback. Zero test changes were needed.

### Pattern: Wide Span Attributes Over Pre-Aggregated Counters

`classification`, `event.type`, `subscribers.count`, and similar values are placed on span attributes rather than incrementing Prometheus counters. A Prometheus counter commits to a specific aggregation at write time — once `events_by_type_total{type="sensor"}` exists, it can only be queried as "how many sensor events total," never "which sensor events came from source X," because source was not a label. Span attributes are stored raw and queryable in any combination via TraceQL. The tradeoff: TraceQL requires a running Tempo instance, while Prometheus counters are queryable without it. The project's posture is that counters exist only for alerting signals (queue depth, error rate); everything analytics-shaped stays on spans.

### Pattern: Async Boundary Context Propagation (RabbitMQ)

Continuing a trace across a RabbitMQ publish/consume boundary uses the W3C TraceContext spec's wire format (`traceparent: 00-<trace-id>-<span-id>-<flags>`). OTel's `propagation.inject(context.active(), carrier)` writes the current span's trace/span ID into a plain object (`carrier`), which is passed as `properties.headers` in `channel.publish()`. On the consumer side, `propagation.extract(context.active(), carrier)` reconstructs a `Context` containing the parent span reference. Starting a new span with that context as parent produces a child span on the same trace, even though the two spans ran in different processes.

### Anti-Pattern Avoided: Silent Error Retry (Treating Parse Failures as Invisible Retries)

Before Phase 15, a message with malformed JSON or a schema mismatch entered the retry loop (retry up to 3×, then dead-letter) with no signal beyond a `console.error`; the same error could recur thousands of times, each instance invisible unless someone was watching logs. The fix: `span.addEvent("message.parse_failed", {...})` on `SyntaxError` and `ZodError` in the worker catch block, carrying `exception.type`, `exception.message`, `msg.routing_key`, `msg.size_bytes`, and `retry.count`. A TraceQL query `{ name="event.process" && event.name="message.parse_failed" }` now surfaces every parse failure across any time window, groupable by exception type, routing key, or retry count.

### Decision: Manual Spans on Business Paths, Auto-Instrumentation as Baseline

Auto-instrumentation (`getNodeAutoInstrumentations()`) covers the low-level I/O: HTTP requests, MongoDB operations, amqplib publish/consume. Manual spans are added only on business-critical operations (`event.process`, `event.observe`) to carry domain attributes that auto-instrumentation cannot know about (`classification`, `subscribers.count`, `changeStream.lag_ms`). The two layers are complementary: auto-instrumentation provides the structural skeleton (how long did the MongoDB write take?), while manual attributes provide the analytical slice (what was the classification of the events that caused slow writes?). `trace.getActiveSpan()` widens a span a framework or auto-instrumentation already created — adding attributes to the Fastify HTTP span in `event.routes.ts` is the example — while `tracer.startSpan()` creates a new named span with its own start/end times and a specific parent context, as with the `event.process` CONSUMER span in `worker.ts`.

### Decision: No pino Migration (Phase 5 Scope)

The plan recommended replacing `console.*` with pino plus `@opentelemetry/instrumentation-pino` for structured log export to Loki. This was deferred: traces are the high-value signal for this phase, and log correlation (Tempo trace ID → Loki log line) requires a running Loki pipeline, addressed in Phase 5. Keeping `console.*` for now avoids a dependency added for infrastructure that isn't running yet.

### Challenge: amqplib Encodes Non-String Header Values as Buffer Objects

When the worker reads `msg.properties.headers`, the `x-retry-count` field (an integer on publish) arrives as a `Buffer` object, not a number or string. Passing the raw headers object directly to `propagation.extract()` would cause the propagator to silently fail, since it expects `Record<string, string>`. The fix filters headers to string-valued keys only before extraction:

```typescript
const carrier: Record<string, string> = {};
for (const [k, v] of Object.entries(msgHeaders)) {
  if (typeof v === "string") carrier[k] = v;
}
const parentCtx = propagation.extract(context.active(), carrier);
```

This preserves `traceparent` (a string) and discards `x-retry-count` (a Buffer); the retry count is read separately from the raw `msgHeaders` object before this filter runs, so both concerns are satisfied without interfering. If the unfiltered headers were passed to `propagation.extract()`, the W3C TraceContext propagator's type check on `headers["traceparent"]` would fail (it's a Buffer, not a string), and extraction would silently return the root (empty) context — the incoming trace orphaned with no error thrown. The span would start as a new root trace instead of continuing the publisher's trace, visible in Tempo as disconnected traces instead of a single parent/child waterfall.
