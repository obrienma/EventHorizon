---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-21, graphql, apollo]
---
Q: Why did Phase 0 of the GraphQL work wire up a single `Query.health: String!` field end-to-end before writing any of ADR 0019's real schema or resolvers?

A: To isolate "does the Apollo/Fastify integration actually work" from "are the resolvers correct." `@as-integrations/fastify` was flagged Medium confidence in the ADR — thinner and less battle-tested than Apollo's Express integration — so a minimal boot check (`apollo.start()` → `app.register(fastifyApollo(apollo))` → `curl -X POST /graphql` returning `{"data":{"health":"ok"}}`) meant that if it had failed, the failure would unambiguously be in the integration layer, not buried under real query logic layered on top.

Extra: EventHorizon · Phase 21 · Pattern: Prove the Integration Boots Before Writing Real Resolvers
See: docs/journal/eventhorizon-2026-07-06T0900-graphql-scaffold.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-21, graphql, apollo, adr]
---
ADR 0019 flagged `@as-integrations/fastify` as `{{c1::Medium confidence}}`, asking for early validation rather than assumed correctness. The Phase 0 boot check hit {{c2::no rough edges}} — no version mismatch, no missing drain-plugin wiring, no context-function surprises — upgrading that confidence for the phases that followed.

Extra: EventHorizon · Phase 21 · Decision: Apollo Server's Fastify Integration Confidence Upgraded from Medium to High
See: docs/journal/eventhorizon-2026-07-06T0900-graphql-scaffold.md
