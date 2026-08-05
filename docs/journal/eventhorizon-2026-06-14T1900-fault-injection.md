---
id: eventhorizon-2026-06-14T1900-fault-injection
repo: eventhorizon
title: "Fault Injection for Dashboard Visuals"
date: 2026-06-14
phase: 17
tags: [fault-injection, opt-in, chaos-engineering, zod, observability, grafana]
cross_ref: observability
cross_ref_id: eventhorizon-2026-06-14T1900-fault-injection
files: [src/config.ts, .env.example, src/ingestion/event.routes.ts, src/seed/producer.ts]
---

### Pattern: Opt-In Fault Injection Behind a Default-Zero Rate

Two independent knobs were added to produce mixed-status traffic for the "EventHorizon Service" dashboard's error-rate panels: `CHAOS_ERROR_RATE` (server, `src/config.ts`/`event.routes.ts`) throws after validation succeeds, producing real 500s and OTel ERROR-status spans; `--error-rate` (seed producer, `src/seed/producer.ts`) sends an otherwise-valid event with `id: "not-a-uuid"`, failing `EventSchema`'s `.uuid()` check and producing real 422s. Both default to `0` and are checked with `Math.random() < rate`. At `rate = 0`, the comparison is always false, so the branch is provably unreachable — `npm test` (`event.routes.test.ts`, 3/3) and normal `npm run dev` traffic are byte-for-byte unchanged from before this phase. The producer's `makeInvalidEvent()` fails specifically because `EventSchema`'s `id` field has a `.uuid()` check — the event's `type`, `payload`, and other fields all still pass their own validation, isolating the failure to one field.

### Decision: Two Independent Knobs Instead of One Combined "Error Mode"

A single `ERROR_RATE` covering both 4xx and 5xx would conflate two different failure domains: 422 is a client-side contract violation (server never starts processing), 500 is a server-side fault (after validation, before the response). Keeping them as separate env var (server) and CLI flag (producer) means each can be tuned independently — e.g. a high `--error-rate` with `CHAOS_ERROR_RATE=0` exercises only the validation path — and the server's chaos knob works against any client, not just the seed producer.

cross-ref: observability — the live verification of this fault injection (Tempo `status=error` spans, Prometheus `http_status_code` series for 422/500/202, and the new "Recent Traces" TraceQL panel) is logged in `rhizome-observability/LEARNING_LOG.md`, including two infra-side challenges hit along the way (a WSL2 crash from heavy Grafana-container introspection, and a Grafana 11.2.0 Tempo query-type limitation).
