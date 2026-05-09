---
title: "Four Planes, One Direction: The Shape of EventHorizon"
date: 2026-03-30
tags: [event-horizon, distributed-systems, architecture, typescript]
summary: Why I named the four stages of the pipeline before I wrote any code, what naming bought me, and what backflow between them would have cost.
---

I started EventHorizon with a single rule, written on a post-it note on my monitor with arrows scrawled all over it: **data flows one direction only.** No plane reaches backwards. No plane phones home. The ingestion layer doesn't query storage. The worker doesn't push to the WebSocket server. The change stream doesn't ack messages back into RabbitMQ. Anything that wants to look upstream is not allowed to. No exceptions.

That rule sounds obvious until you actually try to build a backend without it. The first time you want to "just check if the document is already there before publishing," or "let the worker call back into the API to log a metric," or "have the dashboard tell the worker to retry a failed event" — you realise the rule is doing real work. It is the only thing keeping the system from becoming a graph instead of a pipeline.

So before I wrote a line of code, I named the four planes:

```
Ingestion → Processing → Storage → Observation
```

Then I drew an arrow between them and refused to draw any others.

## Why "planes" instead of "layers" or "services"

I deliberately avoided "layers." Layers stack — they imply something is *on top of* something else, which makes it easy to talk yourself into the upper layer reaching down through the stack. I also avoided "services," because that implies network boundaries that EventHorizon doesn't always have. The worker and the server are separate processes, but the change stream and the WebSocket fan-out share an event loop.

A *plane* is what data-plane / control-plane network architects use to mean: a region of code that owns one specific responsibility for the byte as it flows through. The byte enters one plane, leaves to the next, and never comes back. The metaphor is a conveyor belt with airlocks between sections, not a tower with elevators between floors.

Each plane gets a directory, a doc page, and a single sentence describing what it owns:

| Plane | Owns |
|---|---|
| **Ingestion** | HTTP entry, schema validation, hand-off to RabbitMQ |
| **Processing** | AMQP consumer, enrichment, classification, ack/nack/retry |
| **Storage** | Append-only MongoDB writes, idempotent inserts |
| **Observation** | Change-stream-driven WebSocket push, metrics polling |

If a piece of code doesn't fit cleanly into one of those sentences, it doesn't belong. That includes `utils/` directories, "shared services," and every form of helper that secretly couples two planes together while pretending not to.

## The one thing that crosses every plane

The exception to the no-coupling rule is the event schema itself. `AppEvent`, defined in `src/ingestion/event.schema.ts`, is the shared contract — every plane imports its types from there. The ingestion plane validates inbound payloads against it. The worker switches on the discriminator. The repository persists it. The change stream re-emits it.

This is the only thing planes are allowed to share. It is not a "shared services" directory dressed up as a schema — it is the *contract* the conveyor belt agrees to carry. Without a single source of truth here, the planes immediately start re-validating each other's outputs at every boundary, which is the exact "defensive validation spread" anti-pattern the planes were designed to avoid.

The schema is also not hand-written. It is a Zod object, and every TypeScript type derived from it uses `z.infer<typeof Schema>`. You can't write a type that drifts from the validator if the type *is* the validator. (This single rule earns its own post later in the series — Zod, predictably, won.)

## What backflow would have cost

The point of the one-direction rule isn't aesthetic. Each backwards edge would have caused a specific, expensive failure mode:

**If the ingestion plane queried storage** ("does this event already exist before we publish?"), the HTTP path would have a database dependency. The whole point of the queue is that the ingestion plane can survive even when storage is degraded. RabbitMQ buffers; MongoDB recovers; the dashboard catches up. Adding a Mongo read on the hot ingest path collapses that resilience the moment storage hiccups.

**If the worker called back into the API** ("log a metric for this event"), I'd have introduced a circular dependency between two services that are otherwise independently deployable. The worker would also be doing synchronous HTTP from inside a message-handler callback, which is the kind of thing that makes a 200ms latency spike from the API turn into a 200ms throughput hit on the entire pipeline. Plus, you've got a second failure mode for ack/nack to reason about.

**If the change stream pushed back into RabbitMQ** ("re-publish processed events as a confirmation feed"), I would have wired the observation plane into the message broker, which means the observation plane would crash if RabbitMQ went down — even though it has nothing to do with RabbitMQ. The observation plane only needs MongoDB. Coupling it to AMQP doubles its blast radius for no reason.

**If the dashboard told the worker to retry an event** ("user clicks 'retry' button → API → worker"), the dashboard would have ended up controlling pipeline state. Now the worker has *two* sources of truth for what to do with a failed event: its retry counter and the dashboard's commands. Either you reconcile them (complex) or you let them race (broken).

Each of these would have looked sensible at the time. Each of them would have made the system harder to reason about, harder to deploy, and harder to debug. The one-direction rule isn't there because forward edges are good. It's there because backward edges are *unbounded* — once you allow one, the next is easy to justify, and the system becomes a graph.

## What naming the planes actually bought me

Three things, all of them about communication.

**Locating code.** When I notice a bug, I can usually name the plane in one breath. "The dashboard's connection dot is green but the feed is frozen" → observation plane. "Events show up in MongoDB but never broadcast" → storage-to-observation boundary. The plane name is the first level of triage. Without that, I'd be reading the call stack from `server.ts` outward every time.

**Constraining changes.** When a new feature lands, I can ask: which plane does this belong in? If the answer is "two of them," that is a signal — either the feature is genuinely cross-plane (rare), or I'm about to introduce coupling that will haunt me. Most of the time, the right move is to make the feature live in exactly one plane and emit something the next plane consumes.

**Talking to my future self.** Every doc, every commit message, every `LEARNING_LOG.md` entry refers to a plane by name. Six months from now, when I come back and try to remember why the change stream lives in the server process and not the worker, the answer is in the structure: it's the observation plane, the worker is the processing plane, they don't share memory, MongoDB is the only thing they have in common. The plane names give me a vocabulary that survives the loss of in-the-moment context.

## The boring conclusion

There is nothing fancy about naming four directories and pointing arrows between them. It is the most boring decision I made in this project. It is also the decision that made every subsequent decision easier — because every subsequent decision had a fixed frame to be answered inside.

The deeper lesson, the one I keep relearning: a lot of distributed systems "patterns" are really just rules about *what is not allowed*. Append-only storage is a rule about not updating documents. Idempotent receivers are a rule about not throwing on duplicate inserts. One-direction data flow is a rule about not drawing backwards edges. The patterns are interesting; the rules are what make the patterns survive contact with new requirements.

I named the planes first so the rules had something to attach to. Everything else in this series is a rule attached to one of them.
