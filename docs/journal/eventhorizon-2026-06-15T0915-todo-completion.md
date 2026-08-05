---
id: eventhorizon-2026-06-15T0915-todo-completion
repo: eventhorizon
title: "Completing Intentional-Friction TODOs"
date: 2026-06-15
phase: 19
tags: [test-driven-development, typescript, distributive-omit, discriminated-union, idempotent-receiver]
files: [src/processors/classify.ts, src/observation/metrics.ts, src/storage/event.repository.ts, src/processors/classify.test.ts]
---

### Pattern: Stub Tests Encode the Spec the TODO Must Satisfy

Three `// TODO: implement this` blocks left from earlier phases — the `classify` pipeline/sensor branches, `computeRatePerSec`, and `saveEvent`'s insert — had failing tests written first, so the tests were an executable specification. `classify` was filled to the assertions (pipeline `failed`→`critical`, sensor temperature `>85`→`critical`/`>70`→`warning`, discriminant carried in `tags`); `saveEvent` was filled by mirroring the already-complete `saveFailedEvent` (`insertOne` with a `code === 11000` swallow), completing the Idempotent Receiver. No behaviour had to be invented — the stubs were filled to make red tests green, nothing more.

### Anti-Pattern Avoided: Read-Stale Rate Window

`computeRatePerSec` could have simply returned `recentInsertTimestamps.length / windowSec`, but the window is only pruned in `recordInsert` (on write). A stalled stream would then report a stale-high rate indefinitely until the next delivery pruned the array. The implementation filters by the cutoff at read time as well, so the rate decays to zero on its own when deliveries stop.

### Challenge: `Omit` Does Not Distribute Over a Discriminated Union

The `classify.test.ts` helper `makeEvent(overrides: Omit<AppEvent, "id" | "timestamp">)` failed to typecheck. `AppEvent` is a discriminated union, and `Omit<Union, K>` is not distributive: it computes `keyof` over the whole union (the intersection of members' keys) and `Pick`s from that, collapsing the `type`↔`payload` correlation into independent unions, so `{ type: "pipeline", payload: <sensor payload> }` becomes assignable. The fix is a distributive variant, `type DistributiveOmit<T, K> = T extends unknown ? Omit<T, K> : never;`, where the naked `T` in a conditional makes TypeScript apply `Omit` to each union member separately, preserving each variant's discriminant-to-payload binding. This is the same distribution mechanism behind `Exclude`/`Extract`.

### Decision: Fix the Last Typecheck Error Even Though Tests Already Passed

After filling the TODOs, `npm test` was 44/44 green (Vitest transpiles via esbuild and does not type-check), but `npm run typecheck` still failed on the `makeEvent` helper. The helper was fixed rather than left, because the project gates on a clean `tsc --noEmit` — a passing runtime suite that does not type-check is a false green, and the failure was in the file already being edited.
