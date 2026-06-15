---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-19, typescript, types]
---
Q: Why does `Omit<AppEvent, "id" | "timestamp">` break when `AppEvent` is a discriminated union, and what fixes it?

A: `Omit` is not distributive. It computes `keyof` over the whole union — which is the *intersection* of the members' keys — then `Pick`s from that, collapsing the `type`↔`payload` correlation so `{ type: "pipeline", payload: <sensor payload> }` becomes assignable. The fix is a distributive variant: `type DistributiveOmit<T, K> = T extends unknown ? Omit<T, K> : never;`. The naked `T` in the conditional makes TypeScript apply `Omit` to each union member separately, preserving each variant's discriminant-to-payload binding — the same mechanism behind `Exclude`/`Extract`.

Extra: EventHorizon · Phase 19 · Challenge: Omit Does Not Distribute Over a Discriminated Union
See: docs/journal.md#phase-19-completing-intentional-friction-todos

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-19, metrics]
---
`computeRatePerSec` filters `recentInsertTimestamps` by the cutoff {{c1::at read time}}, not only on write, because the window is pruned only in `recordInsert`. Without the read-time filter, a {{c2::stalled stream}} would report a stale-high rate until the next delivery pruned the array.

Extra: EventHorizon · Phase 19 · Anti-Pattern Avoided: Read-Stale Rate Window
See: docs/journal.md#phase-19-completing-intentional-friction-todos

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-19, testing]
---
Q: After filling the TODO stubs, `npm test` was 44/44 green but `npm run typecheck` still failed. How is that possible?

A: Vitest transpiles via esbuild and does not type-check — it strips types and runs. So a runtime suite can be fully green while `tsc --noEmit` still reports errors (here, the `makeEvent` helper's non-distributive `Omit`). A passing suite that doesn't type-check is a false green; the project gates on a clean `tsc --noEmit` separately.

Extra: EventHorizon · Phase 19 · Decision: Fix the Last Typecheck Error Even Though Tests Already Passed
See: docs/journal.md#phase-19-completing-intentional-friction-todos
