---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-17, observability, testing]
cross-ref: observability
---
`CHAOS_ERROR_RATE` and `--error-rate` both default to `{{c1::0}}` and are checked with `{{c2::Math.random() < rate}}`. At the default, this comparison is always false, so the fault branch is provably unreachable — `npm test` and normal `npm run dev` traffic are unchanged unless the flag is set.

Extra: EventHorizon · Phase 17 · Pattern: Opt-In Fault Injection Behind a Default-Zero Rate
See: docs/journal/eventhorizon-2026-06-14T1900-fault-injection.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-17, observability, design]
cross-ref: observability
---
Q: Why are `CHAOS_ERROR_RATE` (server, 500s) and `--error-rate` (seed producer, 422s) two independent knobs instead of one combined "error mode"?

A: They represent different failure domains — 422 is a client-side contract violation caught by Zod's `.uuid()` check before processing begins; 500 is a server-side fault injected after validation succeeds. Separating them lets each be tuned independently (e.g. exercise only the validation path with `CHAOS_ERROR_RATE=0`), and the server's chaos knob applies to traffic from any client, not just the seed producer.

Extra: EventHorizon · Phase 17 · Decision: Two Independent Knobs Instead of One Combined "Error Mode"
See: docs/journal/eventhorizon-2026-06-14T1900-fault-injection.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-17, zod, validation]
cross-ref: observability
---
The producer's `makeInvalidEvent()` triggers a 422 by setting `id: "not-a-uuid"` on an otherwise-valid event. This fails specifically because `EventSchema`'s `id` field has a `{{c1::.uuid()}}` check — the event `type`, `payload`, etc. all still pass their own validation, isolating the failure to one field.

Extra: EventHorizon · Phase 17 · Pattern: Opt-In Fault Injection Behind a Default-Zero Rate
See: docs/journal/eventhorizon-2026-06-14T1900-fault-injection.md
