---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-24, adr, decision-records]
---
Closing ADR 0019 out added a {{c1::"Measured" subsection}} under Consequences rather than just flipping `Status: Proposed` to `Accepted`, because the ADR had made two falsifiable claims worth checking against reality: a Medium-confidence note on the Fastify integration, and an implicit claim that {{c2::DataLoader would fix the N+1 case}}. Both were confirmed with concrete numbers rather than assumed correct.

Extra: EventHorizon · Phase 24 · Decision: Close the ADR Out With Measured Numbers, Not Just a Status Flip
See: docs/journal/eventhorizon-2026-07-06T0945-graphql-adr-closeout.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-24, adr, decision-records]
---
Q: Why does an ADR that only ever states intentions and never records what actually happened "lose its value as a decision record over time"?

A: An ADR's purpose is to be the record future readers consult to understand why a decision was made and whether it held up — a status field alone (Proposed → Accepted) answers only "did we do it," not "was the reasoning that justified doing it actually borne out." ADR 0019 made two specific, falsifiable claims — a Medium-confidence note on the Fastify integration's ergonomics, and an implicit bet that DataLoader would fix the N+1 case. Closing it out by measuring both (integration hit no rough edges across three phases; DataLoader cut 5 queries to 1, counted via Collection.prototype patching in Phase 2) turns the ADR from a plan into a verified record — the next reader doesn't have to take the original reasoning on faith.

Extra: EventHorizon · Phase 24 · Decision: Close the ADR Out With Measured Numbers, Not Just a Status Flip
See: docs/journal/eventhorizon-2026-07-06T0945-graphql-adr-closeout.md
