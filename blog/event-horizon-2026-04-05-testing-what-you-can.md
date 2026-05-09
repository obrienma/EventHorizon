---
title: "Testing What You Can, Naming What You Can't"
date: 2026-04-05
tags: [event-horizon, testing, vitest, mongodb, distributed-systems]
summary: There are parts of this system I have no automated tests for, and that is a deliberate design decision. The trick is being honest about which parts those are and why.
---

I want to talk about the test suite for EventHorizon, because the most interesting thing about it is what's *not* in it.

The codebase has tests for routes, workers, processors, repositories, and the metrics module. It has zero tests for change streams, WebSocket fan-out, and graceful shutdown. That gap is intentional, it has reasons, and the reasons are the actually-useful part of the testing story.

Most "testing strategy" posts are about how to test things. This one is about how to be honest about what you're not testing, and why I've started thinking of *naming the gaps* as part of the test suite itself.

## The pyramid I actually have

```
┌─────────────────────────────────────────┐
│  pure unit tests                        │
│  enrich, classify                       │
├─────────────────────────────────────────┤
│  Fastify inject + vi.mock               │
│  routes (publishEvent stubbed)          │
├─────────────────────────────────────────┤
│  worker tests with mocked collaborators │
│  parse + dispatch logic                 │
├─────────────────────────────────────────┤
│  repository tests, real MongoDB         │
│  via mongodb-memory-server              │
├─────────────────────────────────────────┤
│  fake timers + sliding windows          │
│  metrics rate / lag                     │
└─────────────────────────────────────────┘

  not automated:
    change stream end-to-end
    WebSocket broadcast fan-out
    graceful shutdown sequencing
```

The mock boundary moves down as you descend the pyramid. At the top, processors are pure functions — same input, same output, no I/O, trivially testable with no fixtures beyond a literal event. At the bottom, the repository tests run against a *real* MongoDB instance (via `mongodb-memory-server`, which spins up an in-memory replica node per test process). Between those poles, each layer mocks its collaborators and tests its own logic.

This is sometimes called the "mockist" or London-school approach: each unit is tested in isolation, with collaborators replaced by mocks. It pairs well with top-down builds — you mock the thing below you until you've actually built it. EventHorizon was built top-down, so the test suite mirrors that build order. Routes were tested with `publishEvent` mocked; later, the worker was tested with the repository mocked; later still, the repository was tested against real Mongo.

## Why pure functions get the cheapest tests

`enrich.ts` and `classify.ts` are the easiest tests in the codebase, by an enormous margin:

```ts
it("classifies a sensor reading above the threshold as critical", () => {
  const event = makeSensorEvent({ value: 95 });
  expect(classify(event)).toBe("critical");
});
```

No mocks. No fixtures. No `beforeEach`. No async. No fake timers. Call the function, assert the return value, done. Twelve lines for a complete behavioural test of a non-trivial classifier.

This is not a coincidence. *Pure functions are cheap to test because they have no observable behaviour beyond their return value.* Anything you'd need to set up — a database, a clock, a dependency — would be evidence that the function is impure. The cost of a test is roughly proportional to the number of side effects in the unit under test. If you want cheap tests, write code with fewer side effects.

I keep this in mind when designing pipelines: anywhere I can carve a side-effect-free function out of an otherwise side-effecty module, I do, because I get a free unit test out of it. `enrich` and `classify` aren't pure by accident; they're pure because they're the parts of the worker I most wanted easy to test.

## Why the repository tests use real MongoDB

The repository sits at the I/O boundary. Its job is to insert documents and handle the duplicate-key case. You could mock the MongoDB driver, but you'd be testing your understanding of the driver, not the actual interaction with MongoDB. The bit that matters — *does the unique index actually catch duplicate inserts and produce error code 11000?* — only exists when you talk to a real database.

`mongodb-memory-server` solves this elegantly: it downloads a MongoDB binary on first use, starts an ephemeral instance per test process, and tears it down at the end. Tests get a fresh database per run, no shared state, no live infrastructure required. The test code reads the same as production code; the only difference is the connection string.

```ts
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
});

it("absorbs duplicate inserts silently", async () => {
  await saveEvent(event, processed);
  await expect(saveEvent(event, processed)).resolves.toBeUndefined();
});
```

This test would be meaningless against a mock. *Of course* a mocked driver returns whatever I told it to return. The test is verifying real MongoDB behaviour: that the unique index produces a duplicate-key error and that my catch handles it correctly. Both halves of the contract — index + handler — are exercised.

The general principle: **mocks are useful for testing the *unit's logic*. Real implementations are necessary for testing the *unit's contract with its dependency.*** The repository's contract with MongoDB is the entire point of the repository; mocking it would erase exactly the thing I want to test.

## Why metrics tests need fake time

The metrics module computes processing rate over a rolling 60-second window. Testing this with real time is a non-starter — your test would either run for a minute or be flaky. Vitest's `vi.useFakeTimers()` lets me freeze the clock, advance it deliberately, and assert on the result:

```ts
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
});

it("computes rate over the rolling window", () => {
  for (let i = 0; i < 10; i++) {
    recordProcessed();
    vi.advanceTimersByTime(1000);
  }
  expect(currentStats().processingRatePerSec).toBeCloseTo(10/10);
});
```

Time is a side effect, just like I/O. Fake time makes time-dependent code testable in the same way that mocks make I/O-dependent code testable: you replace the unobservable, non-deterministic dependency with a deterministic one you control.

A subtle thing: I use `vi.setSystemTime` to anchor the clock at a known timestamp before each test. Without that, the test depends on whatever time the runner happens to start. Anchoring makes test results identical from one run to the next, which makes failures debuggable. Flaky tests are worse than no tests; deterministic time is non-negotiable.

## Why I don't test change streams

The change stream is built on MongoDB's oplog, which only exists in a replica set. `mongodb-memory-server` *can* start a single-node replica set, so technically I could test it. But the test would look like:

1. Start a replica set in memory.
2. Open a change stream.
3. Insert a document.
4. Wait for the change stream to emit.
5. Assert on the emitted document.

Step 4 is the killer. It is *waiting for a real asynchronous oplog event*, which means the test is timing-dependent in a way that no fake-timer trick can flatten. You either poll with timeouts (flaky) or `await` an iterator that might never produce (deadlocky). The test would either be slow, or unreliable, or both.

More importantly: what would I be testing? That MongoDB's change streams work? They do — that's MongoDB's job, not mine. That my change stream wrapper correctly forwards events? Yes, but the wrapper is a tiny piece of code (less than 100 lines) and any meaningful bug in it would surface in production almost immediately, because the dashboard's live feed is the test harness in practice.

The cost of automating this test is high. The value is low. I write that decision down explicitly — *change stream end-to-end is not automated; the dashboard's live feed is the manual test* — and move on. Naming the gap is part of being honest about what's covered.

## Why I don't test WebSocket fan-out

Same family of problem. To test the WebSocket fan-out, I'd need to:

1. Start the server.
2. Connect N WebSocket clients.
3. Trigger a broadcast.
4. Assert each client received the message.

Step 1 conflicts with the App Factory pattern — the server is exactly the file I went out of my way to *not* import in tests. Steps 2-4 require real socket plumbing, which is timing-dependent and flaky in the same way change streams are.

The WebSocket fan-out logic itself — the `Map<WebSocket, boolean>`, the per-client try/catch, the heartbeat interval — could be unit-tested with fake socket objects. I have not written those tests yet, and I might. But the *interesting* failure modes (zombie connections accumulating, broadcasts blocking on slow clients, heartbeat firing during shutdown) are all timing-dependent in ways that make them hard to provoke deliberately.

In the meantime, the dashboard is, again, the manual test. Open the page, connect, watch events flow. Kill the page. Open more pages. The thing I'd actually be checking — does the WebSocket layer work? — is observable in less than 10 seconds of dashboard use.

This is a defensible decision *only if* I'm honest about it. The risk is that a regression in the fan-out logic ships unnoticed because no test catches it. The mitigation is that the dashboard is exercised every time I run the system end-to-end, which is several times per development session. That's not as good as a unit test. It is much better than nothing.

## Why I don't test graceful shutdown

The seven-step shutdown sequence is *exactly* the kind of thing that would benefit from automated testing. It has an order. It has dependencies. Each step has a precondition. The failure modes are all "what if the order is wrong?" which is the kind of question tests are great at answering.

The reason I don't have one yet is the same reason as the others: spinning up the full system, sending it a signal, and asserting on the teardown order requires a real server, real RabbitMQ, real MongoDB. The setup cost is too high for the iteration speed I want during development.

This is the gap that bothers me most. I could mitigate it with a more granular test: stub out the actual `close()` calls and verify they're invoked in the right order. That would test the *sequencer*, not the underlying calls, and that's probably enough. It's on my "should write" list. It's not yet there.

When I name this gap explicitly, I name it as a *known risk* — the shutdown sequence has been read carefully and reasoned about, but it has not been mechanically verified. If I ever introduce a regression there, I'll find out the hard way (a graceful shutdown that hangs, or that loses an in-flight message). The mitigation is the discipline I covered in the seven-step-shutdown post: write the sequence as the reverse of the data flow, document it, review it carefully when changing it.

## Naming the gaps as part of the suite

Here's the part I'd argue for as a general practice: write down the parts of the system you're not testing, and *why*. In `docs/TESTING.md` I have a section called "Not Automated" that lists each gap, the cost of automating it, and what I do instead.

This serves three purposes.

**It's a forcing function.** Once a gap is written down, you've committed to a position: this is intentionally untested. Every time you re-read the doc, you're asked: *is this still the right call?* If the cost of automating it has dropped (new tooling, new test patterns, new free time), you can revisit. If a regression bites you, you have a clear "I said I wasn't testing this" trail to learn from.

**It calibrates expectations.** Anyone reading the codebase — future me, a collaborator, an LLM — knows up front which behaviours are mechanically verified and which are *trusted*. That trust is bounded and explicit, not implicit and infinite. "We don't test X, we exercise it manually via Y" is a real signal; "we don't test X" without context is a void that gets filled with optimism.

**It distinguishes carelessness from policy.** Untested code looks the same whether you forgot or whether you decided. The doc makes the distinction visible. If something doesn't appear in the "not automated" list and isn't tested, that's a bug in the testing story; if it does appear, it's a known position.

## What this looks like in practice

The `docs/TESTING.md` not-automated section, paraphrased:

- *Change stream end-to-end:* requires a real replica set and timing-dependent assertions. Not worth the cost. Manual: dashboard live feed.
- *WebSocket broadcast fan-out:* requires real sockets. Not worth the cost. Manual: open multiple dashboard tabs and observe.
- *Graceful shutdown:* full-process orchestration is heavy. Should write a sequencer-level test (stubbed closes, verify order). On the list, not done.

Three sentences. The ratio of "what's tested" to "what's documented as not tested" is roughly even. That feels right for a learning project; in a production system I'd want the not-tested list to be smaller, but I'd want it to *exist*.

## The boring takeaway

There is a kind of testing-purist position that holds: if you can't test it automatically, you've designed it wrong. I think that's mostly correct and occasionally wrong. The cases where it's wrong tend to be the cases where the test cost is dominated by orchestration (real servers, real network, real time) and the failure mode is observable from the outside (the live feed is empty, the shutdown hangs, the broadcast is missing).

For those, the right move is honesty: write the test if it's cheap, document the gap if it isn't, and *exercise the behaviour manually as part of the development loop* either way. Don't pretend the gap doesn't exist. Don't paper over it with mocked tests that test your understanding of the dependency rather than the dependency itself. Don't let the absence of a test imply the absence of risk.

The most useful sentence in EventHorizon's testing strategy is the one that says, in writing, *"this is intentionally not tested; here's how we know it works."* Two clauses. The first one is unflinching. The second one is what makes the first one defensible.
