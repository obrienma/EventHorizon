---
title: "Backpressure Is Just a Number You Have To Pick"
date: 2026-04-03
tags: [event-horizon, rabbitmq, distributed-systems, performance]
summary: AMQP prefetch is one integer in one config file. It is also the difference between competing consumers and one worker eating the entire queue while the others sit idle.
---

There is an integer in EventHorizon's config called `WORKER_PREFETCH`. It defaults to 5. It looks like a tuning knob — the kind of value you'd skim past in a `.env` file, assume someone smart picked it, and never think about again. I want to spend a post on it, because that integer is also the answer to the most common "why is my queue system inexplicably slow" question I've seen, and the answer is rarely the one people are looking for.

## What happens without prefetch

When you call `channel.consume(queue, handler)` on a fresh AMQP channel with no prefetch configured, RabbitMQ does the most literal possible thing: it pushes every available message in that queue to your consumer, as fast as the network can carry them, until the queue is empty. They all live in your consumer's memory until you ack each one.

If the queue has 50,000 messages and you have one consumer, that consumer now holds 50,000 unacked messages. If you have two consumers, the first one to connect gets 50,000 messages and the second one gets nothing — because by the time it connected, there were no messages left in the queue to distribute. The second worker sits there idle, drawing power, holding a connection, doing zero work.

Three failure modes fall out of this immediately:

1. **Memory pressure.** 50,000 events at a few KB each is hundreds of megabytes parked in one Node.js process. With slightly bigger messages or slightly bigger queues, you OOM.
2. **Head-of-line blocking.** A slow message at the front of that prefetch buffer blocks every message behind it. The worker has to finish processing message 1 before it can start message 2.
3. **No load distribution.** Adding more consumers does nothing, because there are no messages left to distribute. You scaled up; throughput stayed flat. You'll think the broker is broken. The broker is fine. The broker did exactly what you told it to do.

This is the *unbounded consumption* anti-pattern. The fix is a single line.

## What prefetch does

`await channel.prefetch(WORKER_PREFETCH)` — that's the line. Under the hood it issues an AMQP `basic.qos` frame which says: *don't deliver more than N unacknowledged messages to this consumer at once.* When the consumer acks one, the broker delivers the next.

With `prefetch(5)`, a single worker holds at most 5 messages in flight. The other 49,995 stay in the broker's queue, where they're available for distribution to whichever consumer asks for them next. A second worker connecting now gets up to 5 messages of its own. A third worker gets 5. Throughput scales horizontally because the broker is, finally, allowed to act as a distributor instead of a firehose.

This is the *competing consumers* pattern, and prefetch is the mechanism that makes it real. Without prefetch, "competing consumers" is just a marketing diagram — the first consumer wins everything and the rest watch.

## Why 5 specifically

I picked 5 as the default and I want to be honest about how I picked it: I made it up. Then I reasoned about why it was probably okay for this project, and now I'll reason about it on the page so the number stops being arbitrary.

The right prefetch number is a function of three things:

**How long it takes to process one message.** EventHorizon's worker pipeline is `parse → enrich → classify → save to MongoDB`. Most of that is in-memory work; the only I/O is the Mongo write, which on a healthy local replica takes single-digit milliseconds. A message lifetime of ~10ms means a single worker can process 100/sec. Prefetch=5 is enough buffer that the worker rarely has to wait for the next message to arrive, but not so much that one slow message creates a long stall queue inside the worker.

**How variable that processing time is.** If most messages take 10ms but a few take 500ms, head-of-line blocking inside the prefetch window matters. With prefetch=1 and a 500ms outlier, your throughput briefly halves. With prefetch=20 and a 500ms outlier, you've got 19 messages stuck behind it. Higher prefetch trades latency variance for throughput.

**How many consumers you want competing.** If you have one worker and a deep queue, prefetch=1 leaves the broker constantly nudging you for the next message — measurable RTT overhead. If you have ten workers and a shallow queue, prefetch=50 means the first worker grabs the whole queue and the other nine starve.

For EventHorizon: low-variance processing time, single-digit consumer count, modest queue depths in normal operation. Prefetch=5 leaves room for a few in-flight messages without hoarding. If I scale to 10 workers I'd probably leave it at 5. If processing times got more variable, I'd drop it. If I started seeing the worker stall waiting for the broker (RTT-dominated), I'd raise it.

## The thing I want you to internalise

Prefetch is not a *performance optimisation*. It is the mechanism by which your queue distributes work. With it, you have competing consumers. Without it, you have one consumer that ate everything and N-1 consumers watching.

I phrase it that way deliberately, because the framing matters. If you treat prefetch as a tuning knob, you'll leave it at the default and tune other things. If you treat it as an architectural switch — *the system is broken in a specific named way without it, and the names are "head-of-line blocking" and "unbounded consumption"* — you'll set it on day one and then tune it later.

## The thing nobody seems to mention about backpressure

Prefetch is RabbitMQ's *consumer-side* backpressure. There is also a publisher-side backpressure story, and it is much less talked about.

When you call `channel.publish(...)`, the AMQP client buffers the message until it can write it to the socket. If the broker is slow to accept writes — a busy broker, a slow network, a flow-controlled connection — that buffer fills up. `publish` returns `false` to tell you: *I accepted this, but the buffer is full, please slow down.*

If you ignore that return value (and most code does), you keep calling `publish`, the buffer keeps growing, and eventually you've got a lot of unsent messages parked in your producer's memory. From the producer's perspective, everything is fine — `publish` returned `false` but you didn't read it. From the broker's perspective, nothing has changed. From the *process memory* perspective, you're slowly leaking until OOM.

EventHorizon's `publishEvent()` doesn't do anything fancy here — it logs a warning if `publish` returns false, but it doesn't block. For this project that's fine; the publisher is the HTTP route handler and the request rate is bounded by external clients. In a higher-throughput scenario I'd want to actually pause the producer until the channel emits `'drain'`, which is the symmetric backpressure signal on the publish side.

The general principle: **backpressure is signalling, and signals only work if both ends listen.** The broker uses prefetch to tell the consumer "don't hold more than N." It uses `publish` returning `false` to tell the producer "I can't accept more right now." Either signal alone is half a system. Together they form the closed loop that lets the broker push back on overload without dropping messages or growing memory unboundedly.

## What I tell myself when I'm setting prefetch

When the prefetch question comes up — usually because the queue is misbehaving — I run through three checks:

1. **Is prefetch set at all?** If the answer is "no" or "I think the default is fine," set it. Whatever you set it to is better than nothing.
2. **Is throughput proportional to consumer count?** If you double consumers and throughput doesn't move, prefetch is too high — one consumer is hoarding. Lower it.
3. **Is the worker idling between messages?** If `top` shows your worker mostly waiting, prefetch is too low — the consumer keeps emptying its window before the broker can refill. Raise it.

That's it. Three checks. Most of the time the right answer is between 5 and 50, and the exact number doesn't matter as much as *the number existing at all*.

## The boring takeaway

A surprising amount of distributed-systems engineering is just *making sure that the named failure modes can't happen.* Head-of-line blocking, poison pills, unbounded consumption, the thundering herd, the slow-consumer problem — these have names because they show up over and over, and the names exist so you can recognise them in the field instead of rediscovering them as novel bugs.

`channel.prefetch(5)` is the line of code that makes "head-of-line blocking" and "unbounded consumption" not happen. It's one line. It's one number. The number isn't even particularly important. What matters is that it's there, and that you know what it's protecting you from.

Backpressure isn't a problem. Backpressure is the *answer* to a problem. The problem is that the broker can produce work faster than your consumers can finish it, and somebody has to push back. Prefetch is how the consumer says: *not so fast.*
