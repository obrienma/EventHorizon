---
id: eventhorizon-2026-07-06T0900-graphql-scaffold
repo: eventhorizon
title: "GraphQL Query API, Phase 0 (Scaffold)"
date: 2026-07-06
phase: 21
tags: [graphql, apollo-server, fastify, integration-boot-check, adr]
files: [src/graphql/schema.ts, src/graphql/resolvers.ts, src/graphql/loaders.ts, src/graphql/plugin.ts, src/app.ts, package.json, docs/adr/0019-graphql-query-api-over-fastify.md, .claude/plans/graphql-query-api.md]
---

### Pattern: Prove the Integration Boots Before Writing Real Resolvers

Per `.claude/plans/graphql-query-api.md` Phase 0, the schema was kept to a single `Query.health: String!` field returning `"ok"` and wired end-to-end (`registerGraphQL(app)` alongside the existing `registerWsServer(app)` in `app.ts`) before any of ADR 0019's real schema or resolvers were written. This isolates "does the Apollo/Fastify integration actually work" from "are the resolvers correct" — if the boot check had failed, the failure would unambiguously be in the integration layer, not buried under real query logic.

### Decision: Apollo Server's Fastify Integration Confidence Upgraded from Medium to High

ADR 0019 flagged `@as-integrations/fastify` as Medium confidence — a thinner, less battle-tested integration than Apollo's Express path — and asked for early validation rather than assumed correctness. The Phase 0 boot check (`apollo.start()` → `app.register(fastifyApollo(apollo))` → live `curl -X POST /graphql` against local infra returning `{"data":{"health":"ok"}}`) hit no rough edges: no version mismatch, no missing drain-plugin wiring, no context-function surprises.

### Challenge: None

The scaffold matched the ADR's plan exactly; `tsc --noEmit` and the full Vitest suite (44/44) stayed green with no changes needed outside the new `src/graphql/` files and `app.ts`'s single new import/await pair.
