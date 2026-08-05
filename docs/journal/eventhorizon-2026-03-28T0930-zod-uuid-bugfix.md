---
id: eventhorizon-2026-03-28T0930-zod-uuid-bugfix
repo: eventhorizon
title: "Bug Fix: Zod v4 UUID Validation"
date: 2026-03-28
phase: 6
tags: [zod, uuid, rfc4122, testing, mocking]
files: [src/processing/worker.test.ts]
---

### Challenge: Zod v4 Tightened UUID Validation — Test Fixture UUIDs Silently Broke

Three worker tests were failing with `saveEvent` never being called and `mockCh.ack` never firing. The test fixture used `id: "00000000-0000-0000-0000-000000000001"` — visually UUID-shaped and accepted by Zod v3. In Zod v4, `z.string().uuid()` validates against the full RFC 4122 spec including the version nibble (`[1-8]`) and variant nibble (`[89abAB]`); the fixture ID has `0` in both positions and is not the special nil UUID (`...000`), so it fails parse, and the worker never reaches `saveEvent`. The failure mode was confusing because the tests were asserting `saveEvent` was called zero times, which looks like a mock not being applied — classic `vi.mock()` cross-contamination symptoms. The real cause was upstream: the Zod parse inside the worker threw before the storage call was ever reached, and the stderr log showed the `ZodError`, but it was easy to overlook while focused on mock assertion failures. The fix was replacing the fixture UUID with a proper RFC 4122 v4 UUID: `550e8400-e29b-41d4-a716-446655440000`.

### Anti-Pattern Avoided: "UUID-shaped" strings in test fixtures

Using hand-crafted IDs like `00000000-0000-0000-0000-000000000001` is convenient but not standards-compliant; when a validator enforces the spec strictly, these break silently, with no compile error and no obvious test failure message pointing at the real cause. The fix going forward is to use real UUIDs in fixtures — `crypto.randomUUID()` or a well-known valid UUID constant.
