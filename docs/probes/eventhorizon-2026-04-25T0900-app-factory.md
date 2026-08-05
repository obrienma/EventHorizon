---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, testing, anti-pattern]
---
In the original `src/server.ts`, importing the module for `inject()`-based tests triggered `{{c1::app.listen()}}` at module top-level, binding port 3000. If the dev server already held that port, the error handler called `{{c2::process.exit(1)}}`, killing the entire Vitest worker process before any test ran.

Extra: EventHorizon · Phase 8 · Anti-Pattern Avoided: Import = Side Effect
See: docs/journal/eventhorizon-2026-04-25T0900-app-factory.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, testing, anti-pattern]
---
Using port 0 (OS-assigned) would only sidestep the port collision — it wouldn't prevent `{{c1::connectDb()}}`, `{{c2::connectQueue()}}`, and `{{c3::startMetrics()}}` from firing at import time. The root cause, {{c4::I/O at import time}}, would remain.

Extra: EventHorizon · Phase 8 · Anti-Pattern Avoided: Import = Side Effect
See: docs/journal/eventhorizon-2026-04-25T0900-app-factory.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, architecture, testing]
---
The App Factory pattern splits a server module into `{{c1::app.ts}}` — pure construction (Fastify instance, plugins, routes, no network I/O) — and `{{c2::server.ts}}` — the entry point that runs all startup I/O (DB, queue, change stream, metrics), binds the port, and registers signal handlers. Tests import only `app.ts`.

Extra: EventHorizon · Phase 8 · Pattern: App Factory
See: docs/journal/eventhorizon-2026-04-25T0900-app-factory.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, architecture, design-decision]
---
Q: Why does splitting into app.ts / server.ts structurally prevent the "Import = Side Effect" problem, rather than just wrapping the I/O calls in a start() function within one file?

A: A start() function still requires the test to explicitly not call it — fragile, since a future developer or test setup might call it anyway. The file split makes the contract structural: app.ts cannot start a server because it contains no listen() call at all. Importing app.ts yields a pure value with no affordance for side effects — there's nothing to accidentally invoke.

Extra: EventHorizon · Phase 8 · Pattern: App Factory
See: docs/journal/eventhorizon-2026-04-25T0900-app-factory.md
