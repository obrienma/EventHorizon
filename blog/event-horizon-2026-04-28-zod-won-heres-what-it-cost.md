---
title: "Zod Won. Here's What It Cost."
date: 2026-04-28
tags: [event-horizon, zod, typescript, validation]
summary: I evaluated Valibot. I picked Zod. I lost half a day to a UUID validator that was technically more correct than the previous version. Here is what I'd tell my past self about validation libraries.
---

There's a recurring genre of TypeScript blog post: *"Why I switched from Zod to Valibot,"* usually followed by a bundle-size chart and the words "tree-shakeable" highlighted in bold. I read several of them while picking a validation library for EventHorizon. They are not wrong, exactly. They are answering a question I did not have.

This post is the inverse: why I picked Zod, what the deciding argument turned out to be, and the specific bug Zod 4 then handed me on a Saturday morning that I want to tell my past self about.

## The decision in two sentences

EventHorizon is a server-side Node.js process. There is no browser bundle. The Valibot bundle-size argument — its central pitch — does not apply. Therefore: Zod, on ecosystem maturity and community familiarity, with no compensating downside.

That's the entire ADR (it's number 0012 if you want to read the long version). I knew the decision before I'd finished writing the context section. I included Valibot in the alternatives table because writing down the comparison is how you make the decision durable — six months from now, when someone asks "why didn't we use Valibot?", I want the answer to be in the repo, not in my head.

The trickier question is the one underneath this: *why is the bundle-size pitch the centre of Valibot's marketing?* Because most TypeScript validation users are writing browser code. Form validation, API client validation, edge-runtime workers. The audience for which "100KB vs 12KB" is the deciding number is a real and large audience. EventHorizon is not in that audience. The deciding number for me was *"how many Stack Overflow answers exist for the obscure thing I'm about to hit?"* — and on that axis, Zod wins by orders of magnitude. Both libraries are excellent. The question is which one matches your context.

The general principle: *evaluate libraries against your actual constraints, not the constraints in their marketing.* If a library leads with "fast" or "small" or "tree-shakeable," check whether you care about the dimension before you care about the score.

## What Zod actually buys you

Three things, in order of importance:

**`z.infer<>`.** A Zod schema is also a TypeScript type. You write the schema once, and `type Foo = z.infer<typeof FooSchema>` gives you the exact TS type derived from it. There is zero possibility of drift between the validator and the type — they are the same declaration, viewed two ways. This is the load-bearing reason to use Zod (or Valibot, or any inference-friendly validator). Hand-written interfaces alongside hand-written validators is a *guaranteed* source of long-term bugs, because they will silently diverge and the compiler can't help you.

**Discriminated unions.** EventHorizon's events are one of three types — `pipeline`, `sensor`, `app` — each with different required fields. `z.discriminatedUnion("type", [...])` lets me describe that as a single schema. TypeScript narrows the type on `event.raw.type` checks. Zod parses the right shape based on the discriminator. One declaration, three flavours, full type safety with no `as` casts anywhere downstream.

**The ecosystem.** `@fastify/type-provider-zod`, `zod-to-openapi`, `drizzle-zod`, and a hundred other libraries treat Zod as a common currency. When I add an OpenAPI generator, an OpenTelemetry tracer with schema-aware sampling, or a database ORM, the question "does this play with Zod?" almost always answers itself before I check. Valibot is *catching up* on this dimension, but "catching up" is not the same as "is the default."

These three are the meaningful wins. The bundle size debate is a side-show.

## The bug, told properly

I want to talk about the UUID bug, because it's a great little parable about how dependency upgrades hurt.

EventHorizon was using Zod 4. The worker tests used a fixture event with `id: "00000000-0000-0000-0000-000000000001"` — a sequential, hand-crafted UUID, the kind every test fixture I've ever written has used. Three tests started failing the morning I ran them, and the failures looked like this:

```
expected saveEvent to have been called once, was called 0 times
expected mockCh.ack to have been called once, was called 0 times
```

Mock not being called, in three tests. Classic signature of a `vi.mock()` that didn't apply — cross-contamination, hoisting issues, factory function not running early enough. I spent forty minutes there. I rearranged the imports. I inspected the call to `vi.mock`. I added `console.log` to the mock factory to confirm it was running. It was.

Then I noticed the stderr output between the test diff lines:

```
ZodError: Invalid uuid at "id"
```

The test fixture wasn't valid. The worker was parsing the event, the parse was throwing, the worker's catch block was doing exactly what it should — routing to the dead-letter path — and `saveEvent` was never reaching its mock. The "mock not called" assertion failure was a downstream symptom of an upstream parse failure.

What had changed: Zod 3 → Zod 4 had tightened the UUID validator to actual RFC 4122 conformance. The 3rd group's leading nibble has to be `[1-8]` (the version). The 4th group's leading nibble has to be `[89abAB]` (the variant). My fixture had `0` in both, and was not the special-cased nil UUID — so it was just an invalid UUID by spec. Zod 3 accepted any 8-4-4-4-12 hex string. Zod 4 enforces the real spec. The fixture had been invalid all along; only Zod 3's permissiveness had been hiding it.

Fix: replace the fixture with `550e8400-e29b-41d4-a716-446655440000`, an actual v4 UUID. All three tests passed. The bug was forty minutes of searching followed by a one-line patch.

## What I want my past self to know

Two things, both general past the specific bug.

**When a test fails in a way that looks like infrastructure (mocks, timers, modules), check the upstream first.** "Mock was never called" almost never means the mock didn't apply; it usually means the code path that would have called the mock got short-circuited earlier. Always read stderr alongside the assertion failure. Validation errors love to hide there.

**When a validator gets stricter, your fixtures break, not your code.** This is a very specific category of bug, and it's especially treacherous because:

- The change is technically a bug fix in the library.
- Your *code* is fine; the breaking change is in your *test data*.
- The error message is from the library, not from your assertions.
- Test fixtures are the lowest-trust code in any codebase. Nobody reads them. Nobody updates them. They sit at the bottom of the file like geological strata.

The general lesson: **test fixtures should be standards-compliant from day one, even when convenient shortcuts work.** `00000000-0000-0000-0000-000000000001` is convenient. It's also not a UUID. The day a stricter validator lands, every "convenient but not really conformant" thing you've written becomes a failing test.

For UUIDs specifically: use `crypto.randomUUID()` in fixtures (gives you a real v4 every time), or hardcode a single known-good UUID constant for stability. Don't hand-craft them. They look fine until they don't.

## The smaller wins from `z.infer<>`

I want to spend a minute on the `z.infer<>` rule because it is, without exaggeration, the single most useful TypeScript discipline I've adopted in the last few years.

The rule: *if a value has a Zod schema, its TypeScript type is `z.infer<typeof TheSchema>`. Period. No hand-written `interface` shadowing it.*

Why: any time you write the same type information twice, the two copies will eventually drift. The compiler can't catch the drift, because they're separate declarations that happen to look similar. Six months later, you'll be debugging a mysterious bug where the schema validates one shape and the type system describes another, and the gap between them is the size of one field.

`z.infer<>` makes drift impossible by construction. There is one declaration. The type and the validator are the same thing. You change one, you change both, by definition.

I apply this rule even when the schema is "obviously" simple:

```ts
// Bad — they will drift:
const ConfigSchema = z.object({ port: z.number(), host: z.string() });
interface Config { port: number; host: string; }

// Good — they cannot drift:
const ConfigSchema = z.object({ port: z.number(), host: z.string() });
type Config = z.infer<typeof ConfigSchema>;
```

The bad version doesn't break today. It breaks the day someone adds a field to the schema and forgets the interface. Or vice versa. Or the field's type subtly changes (`z.number().int().nonnegative()` vs `number`) and the type loses information the validator carries. You won't notice until something downstream needs that information.

The discipline is small. The cost of the bad version is months-deferred and painful when it lands.

## Where I'd reach for Valibot

Honestly, narrowly: a browser-bundled context where every kilobyte of payload matters and the schemas are simple enough that the API verbosity doesn't bite. SPA form validation, edge-worker request validation, mobile-first PWA. If I were writing one of those today, I'd genuinely consider Valibot.

For a Node.js server with a Fastify integration story, a sprawling ecosystem of complementary tools, and zero browser concerns: Zod, every time, until something fundamentally changes.

## What the post is really about

The library choice is the visible part. The invisible part — and the part I want to leave you with — is that *the right framing for this kind of decision is "evaluate against your context, not their marketing."* Valibot's pitch is real. It's also irrelevant to my context. I would have made a worse decision if I'd let the pitch frame my evaluation.

ADR 0012 captures this in one paragraph. The ADR exists not because the decision is hard but because the *reasoning* is the durable artifact. Six months from now, when I look at the file and see Zod and ask why, I want the answer to be specific to this project, not "Zod won the popularity contest." It's specific to this project: server-side, no bundle concerns, ecosystem-leveraging, Fastify-integrated.

Zod won. The cost was a Saturday morning fixing test fixtures that were never standards-compliant in the first place. I'd take that trade every time.
