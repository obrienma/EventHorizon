---
title: "Resume Tokens and the Lie of 'Just Reconnect'"
date: 2026-04-10
tags: [event-horizon, mongodb, change-streams, distributed-systems, debugging]
summary: The dashboard said everything was fine. Stats updated. Connection dot was green. Nineteen thousand events had moved through the pipeline and the live feed was a frozen screenshot.
---

I want to start with the symptom, because the symptom was the entire problem.

The server was running. RabbitMQ was happily eating events. The worker was processing them, classifying them, writing them into MongoDB. The metrics interval was broadcasting a fresh stats payload every five seconds. The dashboard's WebSocket was open — green dot, ping/pong responding on schedule. The "events processed" counter was climbing steadily.

The live feed was empty. Or rather: it had a snapshot of events from earlier in the session, and that snapshot had not changed in twenty minutes.

`totalProcessed: 19,661`. Live feed: blank. Connection: healthy. No errors visible.

This is the kind of bug that makes you doubt your sanity, because every signal you're trained to look at is telling you the system is fine. The connection indicator was green; I'd written it. The stats counter was climbing; I'd written that too. The fact that the dashboard *appeared* healthy was an indictment of the dashboard, not a reassurance about the system.

## Two paths, only one alive

The observation plane has two sub-paths, and they fail independently.

```
MongoDB
  ├── change stream (cursor) ──→ broadcast WS event per insert
  └── countDocuments (query) ──→ broadcast WS stats every 5s
```

The stats path is query-based. Every five seconds, the metrics interval issues a fresh `countDocuments`, gets a result, packages it as a `StatsPayload`, and fans it out. If the connection drops, the next `countDocuments` reconnects automatically — that's the MongoDB driver's job, and it does it transparently. The path is essentially stateless. It can survive almost anything short of a permanent outage.

The change stream path is cursor-based. It's a long-lived `AsyncIterable` pinned to a specific position in the replica set's oplog. When the cursor errors — broker restart, replica set election, a brief network partition — the cursor is *dead*. There is no automatic reconnect. The driver does not transparently rebuild it. The cursor stays dead, the `for await` loop has exited, and nothing is calling `watch()` again.

Stats keep flowing. The connection dot stays green, because the WebSocket is still open. The dashboard looks healthy. But events stopped pushing the moment the cursor died, and *nothing* on the visible side of the system tells you that.

This is a deceptive partial failure, and it took me an embarrassingly long time to find — because every diagnostic instinct I had was looking in the wrong place. I was checking the WebSocket. I was checking the worker. I was checking RabbitMQ. The cursor was the one thing I wasn't checking, because the cursor doesn't really emit any signal *other than* the events themselves.

## The original error handler was a stub

Here's what I had written:

```ts
stream.on("error", (err) => {
  log.error({ err }, "[changeStream] error");
});
```

That's it. It logs. It does nothing else. The cursor dies, the message scrolls off the screen, and the system is now silently broken in one specific channel.

This is the *silent cursor death* anti-pattern, and what makes it so insidious is that the error handler *technically did something*. It wasn't unhandled. It wasn't crashing the process. It just… didn't restart anything. Looking at the code in isolation, it looked like reasonable error handling. Looking at the system in production, it was a black hole that swallowed events.

I had also left a comment in the file: `// TODO: resume token recovery`. Six weeks of comfortable use later, I'd forgotten the TODO existed.

## What change streams give you for free: the resume token

Every event delivered by a MongoDB change stream carries a `_id` field. That `_id` is the *resume token* — an opaque string that encodes the cursor's exact position in the oplog. Pass it back as `{ resumeAfter: token }` when you reopen the stream, and MongoDB replays every event that occurred between when your cursor died and now.

The infrastructure for zero-gap recovery is already there. You don't have to build it. You just have to *use* it.

The fix in `changeStream.ts`:

```ts
let resumeToken: ResumeToken | undefined;
let shuttingDown = false;
let retryTimer: NodeJS.Timeout | null = null;
let backoffMs = 1000;

async function open() {
  const stream = db.collection("events").watch([], {
    fullDocument: "updateLookup",
    resumeAfter: resumeToken,
  });

  stream.on("change", (change) => {
    resumeToken = change._id;       // store every token
    backoffMs = 1000;                 // reset backoff on success
    onInsert(change.fullDocument);
  });

  stream.on("error", (err) => {
    if (shuttingDown) return;
    log.error({ err }, "[changeStream] error, reopening");
    retryTimer = setTimeout(open, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  });
}
```

Now: every delivered event updates the in-memory token. On error, we schedule another `open()` after a backoff delay, passing the last known token. MongoDB replays anything we missed.

A transient cursor failure now produces a brief pause, a log line, a reconnect, and a flood of replayed events catching the dashboard up to current. The pipeline self-heals. The dashboard isn't lying anymore.

## Why exponential backoff and not "just retry immediately"

If MongoDB is unavailable — say, the container is restarting, taking 8-12 seconds — and you reopen the stream every 50ms, you're hammering a dead connection 200 times a second. Logs fill up. CPU spins. None of it makes the database come back any faster.

Backoff starts at 1 second, doubles each failure, caps at 30 seconds. A successful event delivery resets it. A blink-and-you-miss-it network blip recovers fast. A genuine extended outage backs off to a sensible polling rate. The dual-criterion design here — *back off on failure, reset on success* — matters because it makes the system both responsive to good news and patient about bad news.

There's a subtle bit I want to flag: I reset `backoffMs` on `change`, not on `open`. The reason is that the stream can reopen and immediately receive zero events (if the collection is quiet at that moment). If I reset on open, I'd be giving false confidence — the connection might drop again seconds later, and I'd have lost the backoff progression. Resetting on the *first delivered event* confirms the cursor is healthy end-to-end, not just that `watch()` returned.

## The shutdown race I almost missed

Here is a beautiful little distributed-systems trap. The retry timer is a `setTimeout`. The server can shut down while that timer is pending. When the timer fires, it calls `open()`, which calls `getDb()`, which throws because MongoDB has already been closed in the shutdown sequence. The error scrolls past during shutdown logs and is easy to miss.

The fix involves four lines and the order matters:

```ts
async function teardown() {
  shuttingDown = true;            // 1. block new timers
  if (retryTimer) clearTimeout(retryTimer);  // 2. cancel pending
  await stream.close();           // 3. close the cursor
}
```

`shuttingDown` is set *before* `clearTimeout` because there's a microscopic race where the error handler could fire between `clearTimeout` and `stream.close`, scheduling a fresh timer on its way out. Setting the flag first plugs that hole. The error handler now sees `shuttingDown === true` and returns immediately, refusing to schedule.

I tested this exactly zero times in production, but I caught it on a careful read-through after I'd written the recovery logic. The shape of the bug — *teardown order matters when there's a possibility of in-flight async work scheduling more async work* — is the same shape as a dozen other bugs I've seen in long-running services. The pattern is so reliably re-discoverable that I now treat it as a checklist item: any time I add a retry timer, I add a shutdown flag, in that order.

## What I deliberately did not do

I did not persist the resume token. It lives in memory and dies with the process.

This is a real trade-off. With persistence, a full server restart could resume from the exact pre-shutdown position — events written while the server was down would replay on startup. Without persistence, a server restart starts a fresh stream at the current oplog head and any events written during the outage are gone from the *observation plane's* perspective.

But "gone from the observation plane" is not the same as "gone." Those events are still durably stored in MongoDB. The worker wrote them, acked the broker, end of story. The data is safe. The only thing the dashboard misses is the *live notification* of those events, and only for the duration of the server's outage. The observation plane is, by design, a best-effort live overlay — not a delivery guarantee.

For a production system with strict end-to-end delivery SLAs, you'd persist the token (Redis, a dedicated collection, even just a file). You'd pay for a startup-read path and a few new failure modes around stale or corrupt tokens. For this project, an in-memory token is the right scope: it handles the common case (transient cursor failures during a running server) and accepts the rare case (server restart) as a known limitation.

The general principle: *delivery guarantees should match the contract of the layer they protect.* The storage plane promises at-least-once. The observation plane promises best-effort live push. Applying at-least-once to a layer where duplicates would be visible to the user (the dashboard has no deduplication) is the wrong guarantee for the wrong layer. I went into this in the post on idempotent receivers — the tools are the same, but where you apply them depends on what you're protecting against.

## The deeper bug, which is human

The most interesting thing about this bug is that I had written `// TODO: resume token recovery` in the file, six weeks before it bit me. I knew. I wrote down the thing I needed to do. I forgot.

Comments in code are not a backlog. They are not visible to the build system, the tests, or the runtime. A `TODO` is exactly as load-bearing as a sticky note on the back of your monitor. If something matters, it has to live somewhere that you'll be forced to look at — an issue tracker, an ADR with a status field, a failing test marked `todo` in the test runner. Anywhere but a comment.

For EventHorizon, what I now do: every architectural decision that's deferred goes into an ADR with `Status: Deferred` and a date. The ADR shows up in `docs/adr/` next to the accepted ones. It's listed in the index. Six weeks from now, when I'm scanning the index, it's there. It's not buried in `// TODO` text inside a function I haven't opened in a month.

The change stream resume token recovery is now ADR 0011, accepted, with the in-memory-only scope explicitly documented. If the day comes when "in-memory only" is not enough — if the project grows a delivery SLA, or moves to a multi-server deployment where individual servers cycle in and out — the ADR explains exactly what would change and why we didn't do it on day one.

## What I want you to take from this

A long-lived cursor in a distributed system is not a connection. It is a *position*. Connections reconnect; positions don't, unless you explicitly carry them across the reconnection. "Just reconnect" is the lie that makes silent cursor death so seductive — at the network layer, sure, the MongoDB driver reconnects. At the cursor layer, no, you have to do that yourself.

Resume tokens are MongoDB's way of saying: *I'll do the replay if you do the bookkeeping.* The bookkeeping is one closure variable updated on every event. The recovery is one `setTimeout` with a flag and a backoff. Forty lines of code separate "deceptive silent failure" from "self-healing live feed."

The most expensive part of the bug was the twenty minutes I spent staring at a green connection dot wondering why the events had stopped.
