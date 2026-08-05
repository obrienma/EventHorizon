---
id: eventhorizon-2026-03-26T0915-server-skeleton
repo: eventhorizon
title: "Server Skeleton + Ingestion Route"
date: 2026-03-26
phase: 2
tags: [top-down-build, london-school-tdd, mockist, validation-boundary, defensive-validation-spread, zod, nvm]
files: [src/server.ts, src/ingestion/event.routes.ts, src/processing/queue.ts, src/ingestion/event.routes.test.ts]
---

### Decision: Top-Down Build Order

The build starts from the entry point (`server.ts`) and adds each collaborator only when the layer above calls it, rather than building bottom-up (storage first, then queue, then routes). Top-down means there is always a running program — `npm run dev` works from step one — and each new file has an immediate, visible reason to exist, so failure modes surface at the boundary just added rather than somewhere deep in the stack. The tradeoff is that early layers need mocks for the layers below them; bottom-up gives real implementations all the way down, but nothing runs end-to-end until the very last file is written.

### Pattern: London-School TDD (Mockist)

London-school (mockist) TDD tests each unit in isolation by replacing its collaborators with mocks or stubs, in contrast to Detroit-school (classicist) TDD, which uses real implementations wherever possible. The mock boundary moves down as each layer is implemented: the `event.routes.ts` test uses Fastify's real `inject()` but mocks `publishEvent` via `vi.mock()`; the `worker.ts` test uses real processor logic but mocks `repository.insertOne`; the `event.repository.ts` test mocks nothing, using `mongodb-memory-server` for a real implementation with no live infrastructure needed. At the bottom of the stack, the mock boundary disappears entirely.

### Pattern: Validation Boundary

A validation boundary is a single point in the system where all external input is validated before it can travel further — downstream code never re-validates, trusting that anything past the boundary is well-typed. `POST /events` in `src/ingestion/event.routes.ts` is the only entry point for event data; once `EventSchema.safeParse()` succeeds, the resulting `AppEvent` is fully-typed and trusted by RabbitMQ, the worker, and MongoDB alike, none of which re-check its shape. This avoids the **Defensive Validation Spread** anti-pattern — validating the same data at multiple layers (route → worker → storage) redundantly and inconsistently, since each layer might check different fields, creating subtle divergence. One boundary, one source of truth. The route's two outcomes — `202 Accepted` (Zod valid, published to RabbitMQ) and `422` (Zod invalid, rejected) — are the `Received → Queued` and `Received → Rejected` transitions in the pipeline's event-lifecycle state machine.

### Challenge: Zod 4 Strict UUID Validation

Writing test fixtures for the route surfaced `expected 202 to be 422`: the test was sending `"id": "00000000-0000-0000-0000-000000000001"`, a fake sequential UUID common in test fixtures. Zod 4 enforces RFC 4122 strictly — the UUID version nibble (4th group, first character) must be `1–8`; the nil UUID (`000...000`) and max UUID (`fff...fff`) are the only exceptions, and version `0` is invalid. Zod 3 was more permissive, so this is a breaking change between versions. The fix was to use a real RFC 4122 v4 UUID in fixtures: `"123e4567-e89b-42d3-a456-426614174000"`.

### Challenge: NVM Default Node Version Not Active in Shell

Running tests for the first time produced `SyntaxError: Unexpected token '.'` — optional chaining (`?.`) wasn't recognised, because Node 12 was active despite the NVM default being Node 24. The NVM default is set in `~/.nvm/nvm.sh` and applied by `.bash_profile`; a shell that doesn't source `.bash_profile` (a subprocess or non-login shell) falls back to the system Node, which on this WSL2 machine is v12. The fix was `source ~/.nvm/nvm.sh && nvm use 24`, or ensuring the terminal is a login shell that sources `.bash_profile`.
