---
id: eventhorizon-2026-07-06T0945-graphql-adr-closeout
repo: eventhorizon
title: "GraphQL Query API, Phase 3 (ADR Closeout)"
date: 2026-07-06
phase: 24
tags: [adr, decision-records, graphql]
files: [docs/adr/0019-graphql-query-api-over-fastify.md, README.md]
---

### Decision: Close the ADR Out With Measured Numbers, Not Just a Status Flip

`docs/adr/0019` moved from `Proposed` to `Accepted` with a new "Measured" subsection under Consequences, rather than just flipping the status field. The ADR had made two falsifiable claims worth checking against what actually happened: a Medium-confidence note on `@as-integrations/fastify`'s Fastify integration ergonomics, and an implicit claim that DataLoader would fix the N+1 case. Both were confirmed directly — the integration hit no rough edges across three implementation phases (upgraded to High confidence), and the N+1 fix was measured, not assumed (5 queries naive vs. 1 batched, from Phase 2's `Collection.prototype`-patched count). An ADR that only ever states intentions and never records what happened loses its value as a decision record over time.

### Challenge: None

This phase was documentation-only — no code changed, so no new test or typecheck risk. The probe file for the DataLoader mechanism was already written during Phase 2, matching the plan's note that the DataLoader demo was "the one most worth polishing" — it didn't need a separate closeout probe.
