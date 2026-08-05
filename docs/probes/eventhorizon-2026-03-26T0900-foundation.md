---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-1, fail-fast, validation]
---
{{c1::Fail-Fast}} validation means checking all configuration and external inputs at the earliest possible boundary, and {{c2::crashing immediately with a clear error}} rather than letting invalid state propagate deeper into the system.

Extra: EventHorizon · Phase 1 · Pattern: Fail-Fast / Boundary Validation
See: docs/journal/eventhorizon-2026-03-26T0900-foundation.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-1, zod, config]
---
`Number(process.env.PORT) || 3000` is dangerous because `Number("not-a-number")` returns {{c1::NaN}}, which is falsy, so the default silently kicks in with no error reported. Zod's `{{c2::safeParse}}` instead returns a structured error array with field paths and messages.

Extra: EventHorizon · Phase 1 · Pattern: Fail-Fast / Boundary Validation
See: docs/journal/eventhorizon-2026-03-26T0900-foundation.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-1, typescript, zod]
---
A {{c1::discriminated union}} is a type that can be one of several shapes, distinguished by a shared literal field (the {{c2::discriminant}}). The type system narrows to the correct shape once the discriminant is checked, eliminating the need for `as` casts.

Extra: EventHorizon · Phase 1 · Pattern: Discriminated Union (Sum Type)
See: docs/journal/eventhorizon-2026-03-26T0900-foundation.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-1, typescript, zod]
---
In EventHorizon's event schema, the discriminant field is `{{c1::type}}` (`"pipeline" | "sensor" | "app"`). Zod's `{{c2::z.discriminatedUnion("type", [...])}}` uses it to pick the correct schema branch during parse.

Extra: EventHorizon · Phase 1 · Pattern: Discriminated Union (Sum Type)
See: docs/journal/eventhorizon-2026-03-26T0900-foundation.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-1, typescript, zod]
---
`{{c1::z.infer<typeof Schema>}}` derives the TypeScript type directly from the Zod schema, so type and validator can never drift apart. A hand-written interface that approximates a schema is the {{c2::Type Duplication / Schema Drift}} anti-pattern — the compiler can't catch the two declarations diverging.

Extra: EventHorizon · Phase 1 · Pattern: Schema-as-Contract (Single Source of Truth for Types)
See: docs/journal/eventhorizon-2026-03-26T0900-foundation.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-1, typescript, nodenext]
---
TypeScript 6 + NodeNext treats any file with `import`/`export` as an {{c1::ES module}}. `@types/node`'s `declare global {}` augmentations (for `process`, `console`, etc.) only apply in {{c2::ambient (non-module) context}}, so they don't surface inside module files even when `@types/node` is resolved. The fix is an {{c3::ambient declaration file}} (`global.d.ts`, no imports/exports) containing `/// <reference types="node" />`.

Extra: EventHorizon · Phase 1 · Challenge: TypeScript 6 + NodeNext — process and console Not Found
See: docs/journal/eventhorizon-2026-03-26T0900-foundation.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-1, typescript, anti-pattern]
---
Adding `{{c1::"dom"}}` to `lib` in a Node.js tsconfig is the {{c2::Leaky Abstraction}} anti-pattern: it imports the browser's type universe (`window`, `document`, `localStorage`, browser `fetch`), so the compiler silently typechecks browser-only APIs that don't exist in server code at runtime.

Extra: EventHorizon · Phase 1 · Anti-Pattern Avoided: Leaky Abstraction (Wrong lib Fix)
See: docs/journal/eventhorizon-2026-03-26T0900-foundation.md
