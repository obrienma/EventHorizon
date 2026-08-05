---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-6, zod, testing]
---
RFC 4122 requires the 3rd group's leading nibble to be `{{c1::[1-8]}}` (version) and the 4th group's leading nibble to be `{{c2::[89abAB]}}` (variant). `00000000-0000-0000-0000-000000000001` has `0` in both positions. Zod v4 validates these bits strictly — Zod v3 accepted any UUID-shaped string. The only special-cased all-zero UUID is the exact {{c3::nil UUID}} `00000000-0000-0000-0000-000000000000`.

Extra: EventHorizon · Phase 6 · Challenge: Zod v4 Tightened UUID Validation
See: docs/journal/eventhorizon-2026-03-28T0930-zod-uuid-bugfix.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-6, debugging, testing]
---
Q: A worker test fails because `saveEvent` was never called, but your mock setup looks correct. What should you check first?

A: Check what happens *before* `saveEvent` is reached — specifically whether the input passes schema validation. If Zod throws, the worker short-circuits and `saveEvent` is never invoked. The assertion failure ("called 0 times") looks like a mock problem but is actually an upstream parse failure. Always read the stderr output alongside the assertion failures, not just the assertion message.

Extra: EventHorizon · Phase 6 · Challenge: Zod v4 Tightened UUID Validation
See: docs/journal/eventhorizon-2026-03-28T0930-zod-uuid-bugfix.md
