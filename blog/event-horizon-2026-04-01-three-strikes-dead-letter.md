---
title: "Three Strikes and the Dead Letter"
date: 2026-04-01
tags: [event-horizon, rabbitmq, distributed-systems, error-handling]
summary: Why the worker republishes failed messages instead of nacking them with requeue=true, and how a single boolean flag is the difference between a healthy pipeline and a frozen one.
---

The first time I read about RabbitMQ's `nack` method, I felt very clever. Negative-acknowledge a message and tell the broker to put it back in the queue — easy retry, no infrastructure needed:

```ts
ch.nack(msg, false, true); // requeue = true
```

Failed message goes back. Worker picks it up again. If it fails again, it goes back again. Eventually it succeeds, or… it doesn't.

I want to talk about what happens when it doesn't, because that "or… it doesn't" is the entire reason application-level retry exists, and it is also one of the most reliably-stepped-on landmines in message-driven systems.

## What `requeue=true` actually does

`nack(msg, false, true)` doesn't just put the message *back in the queue* — it puts it at the **front** of the queue. The next consumer to ask for a message gets that one, before any of the messages that were behind it. If the message is a poison pill — malformed payload, a bug in the classifier, anything that *will always fail* — every consumer in your fleet will receive it, fail on it, requeue it, and receive it again. In a tight loop. Forever.

While that's happening, every other message in the queue is starved. The poison pill cycles through your workers, hogging the prefetch slot, blocking the messages behind it. RabbitMQ doesn't know it's a poison pill. From the broker's perspective, it's doing exactly what you asked: redeliver the failed message right now.

This is the textbook *head-of-line blocking* anti-pattern, and the canonical name for the failure mode is *poison pill*. Both names tell you what you need to know: a single bad message at the front of the queue can poison the entire pipeline behind it.

I've watched this happen in a job queue I wasn't responsible for. Throughput went from "fine" to "zero" in about thirty seconds. The producer kept publishing, the queue kept growing, the workers were fully utilised — they just weren't making any progress. Every consumer was eating the same poisoned bite over and over.

## The fix: republish to the back, with a counter

EventHorizon's worker doesn't use `requeue=true`. It uses a different pattern, which I think of as "three strikes and the dead letter":

```ts
const retries = (msg.properties.headers?.["x-retry-count"] ?? 0) + 1;

if (retries < MAX_RETRIES) {
  // Republish to the BACK of the queue with an incremented counter.
  ch.publish(EXCHANGE_NAME, msg.fields.routingKey, msg.content, {
    persistent: true,
    headers: { ...msg.properties.headers, "x-retry-count": retries },
  });
  ch.ack(msg);
} else {
  // Give up. Nack with requeue=false → routed to events.dead via DLX.
  ch.nack(msg, false, false);
}
```

Two important things are happening here.

First, the message goes to the **back** of the queue, not the front. Other messages get to move while this one waits. A poison pill no longer blocks the pipeline — it just slowly cycles through retries while everything else makes progress.

Second, the retry budget is tracked **on the message itself** via the `x-retry-count` header. The broker doesn't track this; the worker does. When `x-retry-count` reaches `MAX_RETRIES` (3, in this project), the worker nacks with `requeue=false`. That triggers the dead-letter path.

## What the DLX is for

Every queue in EventHorizon's processing plane has a *dead-letter exchange* (DLX) configured at declaration time:

```ts
await ch.assertQueue("events.work", {
  durable: true,
  arguments: {
    "x-dead-letter-exchange": "events.dlx",
    "x-message-ttl": 30_000,
  },
});
```

When a message is nacked with `requeue=false`, RabbitMQ doesn't drop it — it routes it through `events.dlx` (a fanout exchange) into `events.dead`, a durable queue that no consumer reads from. The dead-letter queue is, in effect, the system's morgue: a place where messages that failed three times go to be inspected by a human (or a separate offline tool).

The DLX is wired up at topology declaration, which happens on every startup via `assertExchange`/`assertQueue`. RabbitMQ's assertion semantics are idempotent: if the topology already exists with the same arguments, it's a no-op; if the arguments differ, it throws `406 PRECONDITION_FAILED`. That last bit has bitten me before — change the DLX wiring on a live queue and the next startup will fail loudly. Which is correct! It's the broker refusing to silently misconfigure itself. But it does mean topology changes need a delete-and-recreate, not an in-place edit.

## Why three strikes

Three is a magic number, but not really. The actual rule is: enough retries to absorb transient failures (network blips, brief MongoDB unavailability, broker reconnection windows), few enough that a permanent failure doesn't cycle through the queue forever.

Two would mean a single transient hiccup retries once and dead-letters on a still-warm second blip. Five would mean a poison pill spends a noticeable fraction of the worker's time before being dead-lettered. Three is a defensible compromise. If your transient failure profile is different — say, an external API that takes longer to come back — the number is yours to tune. What matters is that *the number is finite and bounded.*

The infinite version, which I'll name explicitly because it tempts every junior engineer who reads about queues for the first time: *"just keep retrying until it works."* That's not error handling. That's wishful thinking with a `while` loop. Some failures don't resolve. The whole point of a dead-letter queue is to give those failures a place to go that isn't your hot path.

## What dead-letter messages should not be: invisible

The trap to watch for, once you have a DLQ, is treating it as a black hole. Messages go in, nobody looks. Six months later you discover thousands of dead-lettered events, half of them transient failures that *would have succeeded if you'd just bumped them back into the queue an hour later.*

EventHorizon doesn't yet have a "DLQ replay" tool. I haven't needed it. But the metrics interval includes a `failedCount` that tracks dead-letter activity, and the dashboard's queue-depth widget colours yellow at 50 messages and red at 200. If `events.dead` ever gets non-trivial, I'll know. If it stays at zero — which it does in normal operation — the morgue is empty and I don't have to think about it.

The boring infrastructure principle here: a place for failures to *go* is necessary but not sufficient. You also need a way to *notice when failures pile up there.* Otherwise the DLQ is just a bigger, slower way to lose messages.

## What this looks like as a state machine

Putting the whole worker error path together:

```
receive message
├── parse + process succeeds
│   ├── save to MongoDB
│   └── ack → broker deletes
│
└── error
    ├── retry count < 3
    │   ├── republish to back of queue with x-retry-count + 1
    │   └── ack the original
    └── retry count >= 3
        └── nack(requeue=false) → DLX → events.dead
```

Two ack paths and one nack path, with the retry counter on the message itself rather than in the broker or the worker's memory. The worker is stateless. The broker is the durable state. The retry budget travels with the message. Any worker can pick up any message at any time and know exactly what to do with it.

## Why the worker, not the broker, owns the retry policy

RabbitMQ has its own retry mechanisms — TTL-with-DLX retry queues, plugins, the `delayed_message_exchange`. I considered them. I rejected them for this project because they push the retry policy *into the broker topology*, which means:

1. The broker becomes harder to declare idempotently — more queues, more bindings, more arguments that need to match exactly across deploys.
2. The retry policy is no longer visible in code. To answer "how many retries before dead-letter?" you'd have to read the broker config, not the worker.
3. Different message types can't have different retry policies without forking the topology.

Putting the retry counter in a header and the policy in the worker means the entire flow is one file you can read top-to-bottom. `MAX_RETRIES = 3`. `if (retries < MAX_RETRIES) republish, else nack`. The broker's job is just to durably move bytes around — which is exactly what brokers are good at.

## The single boolean

I started this post by saying `nack(msg, false, true)` was the seductive wrong answer. Here's the same call with the right argument:

```ts
ch.nack(msg, false, false); // requeue = false → goes to DLX
```

The third argument flips. That single boolean is the entire difference between *poison pills cycle through your workers forever* and *failed messages route to a quiet morgue you can inspect later*. The application-level retry counter on top of that is what gives you bounded retries before the morgue.

Three strikes. Then the dead letter. Then your queue keeps moving.
