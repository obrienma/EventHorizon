---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-2, testing, tdd]
---
{{c1::London-school (mockist)}} TDD isolates each unit with mocks for its collaborators; {{c2::Detroit-school (classicist)}} TDD uses real implementations wherever possible, only mocking true external systems. London-school suits top-down builds; Detroit-school suits bottom-up.

Extra: EventHorizon · Phase 2 · Pattern: London-School TDD (Mockist)
See: docs/journal/eventhorizon-2026-03-26T0915-server-skeleton.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-2, http, validation]
---
The ingestion route returns `{{c1::202 Accepted}}` rather than `200 OK` because the event has only been {{c2::queued for async processing}} — it hasn't been processed or stored yet, and 200 would imply the work is already complete.

Extra: EventHorizon · Phase 2 · Pattern: Validation Boundary
See: docs/journal/eventhorizon-2026-03-26T0915-server-skeleton.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-2, validation, anti-pattern]
---
In EventHorizon, the {{c1::validation boundary}} is the POST /events handler in `event.routes.ts`. Once `EventSchema.safeParse()` succeeds, every downstream plane trusts the resulting `AppEvent` without re-checking its shape — re-validating the same data at multiple layers is the {{c2::Defensive Validation Spread}} anti-pattern.

Extra: EventHorizon · Phase 2 · Pattern: Validation Boundary
See: docs/journal/eventhorizon-2026-03-26T0915-server-skeleton.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-2, pipeline, state-machine]
---
In the event-lifecycle state machine, a `POST /events` request that passes Zod validation transitions `Received → {{c1::Queued}}` (published to RabbitMQ); one that fails validation transitions `Received → {{c2::Rejected}}` (HTTP 422).

Extra: EventHorizon · Phase 2 · Pattern: Validation Boundary
See: docs/journal/eventhorizon-2026-03-26T0915-server-skeleton.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-2, zod, testing]
---
Zod 4 enforces RFC 4122 strictly: the UUID version nibble (3rd group, 1st character) must be `{{c1::[1-8]}}`. `00000000-0000-0000-0000-000000000001` has `{{c2::0}}` in that position and is not the special nil UUID, so it fails parse — Zod 3 accepted any UUID-shaped string.

Extra: EventHorizon · Phase 2 · Challenge: Zod 4 Strict UUID Validation
See: docs/journal/eventhorizon-2026-03-26T0915-server-skeleton.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-2, nvm, shell]
---
`node --version` can report v12 despite an NVM default of v24 because NVM's default is applied by sourcing `{{c1::~/.nvm/nvm.sh}}` via `.bash_profile`. A {{c2::non-login shell}} (subprocess, some terminal emulators) skips that file and falls back to the system Node.

Extra: EventHorizon · Phase 2 · Challenge: NVM Default Node Version Not Active in Shell
See: docs/journal/eventhorizon-2026-03-26T0915-server-skeleton.md
