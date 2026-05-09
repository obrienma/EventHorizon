---
title: "The Seven-Step Shutdown"
date: 2026-03-31
tags: [event-horizon, distributed-systems, graceful-shutdown, fastify, rabbitmq, mongodb]
summary: There are exactly seven steps in EventHorizon's graceful shutdown, in exactly one order, and every reordering loses data in a specific way.
---

Most "graceful shutdown" code I've read is one of two things. Either it's a `process.on('SIGTERM', () => process.exit(0))`, which is not graceful, it's just polite. Or it's a kitchen sink of `await`s in whatever order felt reasonable at the time, with a `try/catch` around the whole thing.

EventHorizon's shutdown is neither. It is seven specific steps, in one specific order, each one solving a specific failure mode that *would* happen if you reordered them. I want to walk through it because the ordering is the entire substance of the pattern, and once you understand why, "graceful shutdown" stops being vibes and starts being a sequence with reasons.

## The seven steps

```
1. Stop accepting new HTTP traffic       (Fastify .close())
2. Cancel the AMQP consumer              (channel.cancel(consumerTag))
3. Wait for the in-flight message        (await pendingPromise)
4. Close the MongoDB change stream       (stream.close())
5. Close the MongoDB connection          (client.close())
6. Close the AMQP channel + connection   (channel.close(); conn.close())
7. process.exit(0)
```

If you reorder any two of these, you can describe the bug it produces. Let me do them in order, with the failure modes.

## 1. Fastify first

The HTTP server is the *front door*. Closing it first means: from the moment the signal arrives, no new events can enter the system. Everything downstream gets a fixed, finite amount of work to drain — whatever was already in the queue, plus whatever in-flight requests need to finish. If we left the HTTP server open while we tore down the rest, new events would be arriving and immediately failing on the way to a half-shut-down RabbitMQ. We'd be turning a clean shutdown into a partial outage.

`fastify.close()` does the right thing here: it stops accepting new connections, lets in-flight requests finish, then resolves. Any 202 we've already returned to a client is a promise we now have to keep — the event got published to RabbitMQ before we returned, so the rest of the pipeline owes that event a successful trip through.

## 2. Cancel the consumer, don't close the channel

This is the one that took me a minute to internalise. The instinct is to "stop the worker" by closing its AMQP connection. That's wrong, in a specific way:

- `channel.close()` releases the channel. Any unacked message in the prefetch window is *immediately* requeued by the broker. If the worker is mid-process on one of those messages — `await saveEvent(...)` is hanging in the air — the message gets redelivered to another consumer (or to this same one when it restarts) before the in-flight work finishes. You've duplicated the work without finishing the original.

- `channel.cancel(consumerTag)` is the right verb. It tells the broker: *stop pushing new messages to this consumer.* Messages already in flight stay in flight. The broker doesn't redeliver anything; it just stops the firehose at this consumer. The consumer can finish what it's holding without competing with itself.

Cancel first, finish in-flight, *then* close the channel. The order is not negotiable, because closing first re-introduces the duplicate-delivery race that the at-least-once + idempotent-receiver contract is built to handle but that you should not deliberately invoke.

## 3. Wait for in-flight to finish

Step 2 stops new work from arriving. Step 3 is the patience to let what's already in flight reach its conclusion. EventHorizon's worker tracks a single `pendingPromise` — the message currently being processed, if any — and shutdown awaits it before moving on:

```ts
if (pendingPromise) {
  await pendingPromise.catch(() => {}); // swallow errors
}
```

The `.catch(() => {})` matters. The in-flight message might fail; the worker's normal error path will retry-or-dead-letter it. Either way, we're not the right place to handle that error — we're shutting down, not processing. The shutdown sequence's job is to *let the work finish*, not to evaluate it.

If you skip this step and tear down MongoDB before the in-flight `saveEvent` completes, the in-flight write fails halfway through — the event is partially landed, the ack never fires, the message is redelivered on next startup, the idempotent receiver absorbs the duplicate, and the partial write… is mostly fine because the writes are atomic per document. But you've still introduced a window where you don't really know what happened to that one event, and you'd really rather just *let it finish*.

## 4. Change stream before MongoDB

The change stream is a long-lived cursor; it holds a reference to the MongoDB connection. If you close the connection first, the cursor's `for await` loop throws on the next iteration with a connection-closed error. That error propagates up to the change-stream error handler, which (as covered in the resume-token post) tries to schedule a reconnect on a backoff timer — against a connection that is, at this point, deliberately gone.

You can build defenses against this: a `shuttingDown` flag in the change-stream module, checked before scheduling retries. EventHorizon has one, because the resume-token recovery logic needs it. But the *primary* defense is shutdown order: close the cursor first, *then* the connection. The flag is the seatbelt; the order is not driving into the wall.

## 5. MongoDB connection

By now: HTTP is closed, the consumer has stopped pulling work, the in-flight message has finished, the change stream has been politely told the party is over. The MongoDB driver has no remaining users in this process. Closing the client now is uneventful — exactly what you want from a step in a shutdown sequence.

If you close MongoDB earlier — say, before step 3 — the in-flight `saveEvent` call fails halfway. The worker's catch block routes the message to the dead-letter path, which involves *another* MongoDB write (`saveFailedEvent`) which also fails. The dead-letter routing still happens (because that write is wrapped in `.catch(() => {})` precisely so it can't block the nack), but the observability data is gone. You've turned a clean shutdown into a small data-loss event for whatever was in flight.

## 6. AMQP channel and connection last

The channel is closed *after* MongoDB because the worker's catch block needs the channel to nack/ack messages on the dead-letter path. If we lost the channel earlier and the in-flight save failed, the worker would try to ack on a closed channel and throw. The right ordering keeps the broker reachable until the worker has fully stopped using it.

Closing the channel before the connection is the AMQP convention: channels are logical, the connection is physical. Closing the connection first leaves channels in an unknown state for a brief window. Closing the channel first means the channel cleans up its in-flight commands, *then* the connection wraps up.

## 7. The explicit exit

`process.exit(0)` is the last line. Without it, Node.js will only exit when *all* ref'd handles have been released — and a single missed `clearInterval`, a forgotten `unref()`, or a stray timer keeps the process alive forever, looking hung from outside.

I have, more than once, debugged a "shutdown hangs after Ctrl-C" by running `process._getActiveHandles()` in a console and finding a `setInterval` I forgot to clear. The fix is "make the explicit exit explicit": once the deliberate teardown is complete, *exit*. Don't trust the event loop to figure it out from handle ref-counts alone.

This is partly defensive — `unref()` on the metrics interval and the WebSocket heartbeat would also work, and EventHorizon does both — but defense in depth here is cheap. If the explicit exit fires, the process leaves. No guesswork.

## What this isn't: error handling

It's important to be precise about what the shutdown sequence is *for*. It is not for handling errors during normal operation — those are handled at the worker level, in the dead-letter path, in the change-stream error handler. The shutdown sequence is for handling *the deliberate request to stop*, whether that's SIGTERM from a container orchestrator, SIGINT from your terminal, or a programmatic shutdown.

The signature of "deliberate stop" is that it is *expected* and *bounded*. You know it's happening. You have time to drain. The shutdown sequence is the protocol for using that time well.

This matters because the shutdown sequence is allowed to be slow in a way that error handling is not. A nack-and-dead-letter has to happen in milliseconds because there's a prefetch window behind it. A graceful shutdown can take ten seconds — finishing one in-flight message, flushing a connection — because nothing is waiting for it except the pod restart timer. If your orchestrator gives you a 30-second termination grace period, your shutdown sequence has 30 seconds to do the right thing in the right order.

## The mental model

Every step in the sequence has the same shape: *stop accepting new work at this layer, drain what's in flight at this layer, then release the layer's resources.* Repeat for every layer, in topological order from outermost (HTTP) to innermost (broker connection). The order is determined by which layer holds references to which other layer's resources.

```
Inbound traffic               (HTTP)
  ↓ depends on
Message broker consumer       (AMQP cancel)
  ↓ depends on
In-flight processing          (await pendingPromise)
  ↓ depends on
MongoDB cursor                (change stream)
  ↓ depends on
MongoDB driver                (client.close)
  ↓ depends on
AMQP channel + connection
  ↓ depends on
Process
```

Tear down the chain from the top. Each layer is allowed to assume the layers above it have already stopped feeding it work; each layer is allowed to assume the layers below it are still alive when it does its own teardown. That's the contract.

## The boring ending

Graceful shutdown is one of those topics that gets handwaved a lot. "Just await your closes." In practice, the *order* is the entire pattern, and the order is dictated by the data flow — which means the shutdown sequence is the data flow run *backwards*, with each layer politely refusing to accept new work before its upstream has stopped feeding it.

If you can describe your data flow as a topology, you have your shutdown order: it's the reverse of the data flow's topological sort, plus one explicit `process.exit(0)` at the end.

EventHorizon's seven steps aren't elegant. They aren't clever. They are exactly long enough to handle every dependency cleanly, and exactly short enough that you can read them out loud in one breath. That's the shape graceful shutdown wants to be.
