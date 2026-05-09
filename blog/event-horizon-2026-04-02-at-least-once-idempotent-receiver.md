---
title: "At-Least-Once Is a Lie Without an Idempotent Receiver"
date: 2026-04-02
tags: [event-horizon, distributed-systems, mongodb, rabbitmq]
summary: How I almost shipped duplicate documents into MongoDB, and why I now think of unique indexes as load-bearing infrastructure rather than schema decoration.
---

Here is the failure mode I was sleepwalking into.

The worker pulls a message off RabbitMQ. It validates it, enriches it, classifies it, and writes it to MongoDB. Then — and only then — it acks the message. This is the textbook *at-least-once delivery* pattern: you don't tell the broker "I'm done" until the durable side effect has actually landed. If the worker crashes between the write and the ack, the broker redelivers the message to another consumer. The pipeline keeps moving. Nothing is lost.

I wrote it that way on purpose. I knew the pattern. I'd written it down in `LEARNING_LOG.md` with a flashcard and everything: *"the worker acks AFTER writing to MongoDB, not before."* I was very pleased with myself.

Then I noticed I had no test for what happens when the redelivery actually arrives.

## The thing nobody tells you about at-least-once

At-least-once delivery is a guarantee the broker gives you. It's not a guarantee about your *receiver*. The broker promises: "the message will be delivered to a consumer at least once, possibly more." That "possibly more" is doing all the work. If your receiver is not built to handle the second, third, fifth delivery of the same message, "at-least-once" silently degrades into "I now have N copies of this event in my database."

Which is exactly what would have happened in EventHorizon, because my repository started life as `db.collection("events").insertOne(event)`. No unique constraint. No conflict handling. Just a plain insert. If the same event came down the queue twice — which is *guaranteed to happen* under at-least-once — I'd persist it twice. Two documents, same event, same `raw.id`. Forever.

The dashboard would render a duplicate. The metrics would over-count. Anyone trying to reconstruct a timeline by querying back through the events collection would find phantom events that never actually happened in the source. And nothing would ever flag it, because at the point of the duplicate insert, MongoDB was perfectly happy. From its perspective, two documents that look almost identical are just… two documents.

## The unique index is not schema decoration

The fix is one line in `db.ts`:

```ts
await coll.createIndex({ "raw.id": 1 }, { unique: true });
```

This index is not a performance optimisation. It is not a schema constraint in the data-modelling sense. It is *load-bearing distributed-systems infrastructure*. Without it, the at-least-once contract has no terminator. With it, the second insert of the same event throws a duplicate key error — code `11000` — which I catch and silently swallow.

Here's the actual receiver:

```ts
export async function saveEvent(event: AppEvent, processed: ProcessedMeta) {
  try {
    await coll.insertOne({ raw: event, processed });
  } catch (err) {
    if ((err as MongoServerError).code === 11000) {
      // Idempotent Receiver: redelivery already persisted. No-op.
      return;
    }
    throw err;
  }
}
```

That `if (code === 11000) return` is the entire idempotent-receiver pattern. It says: *a duplicate is not an error, it is the system working correctly.* The redelivery happened, MongoDB rejected the second copy, the receiver shrugs and returns success. The worker then acks the message — the broker forgets about it — the pipeline continues.

## Why narrow exception handling is load-bearing

I want to dwell on the `code === 11000` check, because the tempting wrong move is `catch (err) { return }`, full stop. Swallow everything. What's the worst that could happen?

The worst is this: MongoDB has run out of disk. The insert fails with a *different* error code. My catch-all swallows it. The worker proceeds to ack the message. The broker deletes it. The event is gone — no document in MongoDB, no message in RabbitMQ, no dead-letter trail. Permanently lost. And the only signal would have been a log line scrolling off the screen.

Catching only `11000` means: *duplicate-key is a known-safe condition; everything else is a real failure that should bubble up to the worker's retry-and-dead-letter logic.* Auth errors, replica set elections, network drops, disk full — all of those still propagate. The worker sees them, does its retry dance, eventually dead-letters the message if it can't recover. The system stays correct under partial failure, instead of *appearing* correct while actually losing data.

The width of the `catch` clause is, no exaggeration, the difference between a working pipeline and a silent data-loss bug.

## Save before ack, every time

There's a companion rule that comes with this pattern: *save before ack.* You'd think this is obvious, but I'm including it because the inverse — ack before save — is genuinely tempting in code review when someone goes "shouldn't we ack faster to free the broker memory?"

No. You should not.

Ack is destructive. The broker treats it like a `DELETE` — once it sees the ack, the message is gone. If you ack first and the save fails, you have nothing to retry, nothing to dead-letter, nothing to reason about. The event has left the system through both exits at once.

Save before ack means: if the save throws, the broker still has the message. The catch block can republish with a retry counter, or nack into the dead-letter exchange. The Idempotent Receiver handles the case where the save succeeded but the ack got lost — that's what the unique index is for. Save-before-ack and idempotent-receiver are halves of the same contract. Neither works alone.

Flip the order and you've built at-most-once. Every blog post about "distributed systems delivery semantics" is really a footnote on this single ordering decision in your message handler.

## The anti-pattern I named: update-in-place

Once the unique index was in place, I stopped writing `updateOne` for events entirely. Not just at the worker — anywhere. The `processed` sub-document, the classification result, the enrichment metadata: all of it goes in on the first insert. If I want to "update" an event, I don't. I write a new event with a reference back. The original document is sealed.

The anti-pattern this avoids is the one most CRUD-trained engineers reach for first: *update-in-place.* It's the default mode of an ORM-shaped brain. You receive an event, you find or create a row, you mutate it as it moves through the pipeline. What's wrong with that?

What's wrong is that `find-or-create` is two operations, not atomic, racy under concurrent workers. *Update* is a destructive operation that erases history. *Mutation* spread across a pipeline means there is no single point at which the event's state is "done" — every consumer downstream has to know what version of the document it's looking at and whether the worker has caught up to it yet.

Append-only storage avoids all of this by removing the `update` verb from the system. The worker writes the document with `processed` already populated. The change stream sees one event, not a sequence of mutations. The dashboard renders what it gets. There's no "is this row done yet?" — if the document exists, it's done.

It also pairs naturally with the idempotent receiver. Both are facets of the same idea: *make the database tolerant of being told the same thing twice, and you no longer have to make every other layer perfectly transactional.*

## The mental model shift

Before this project, I'd have told you that `try { insert } catch (DuplicateKey) { return }` was a code smell — that the right way to write that code was a "check, then insert" or an upsert. I now think both of those are wrong, and the catch-and-swallow is correct.

"Check then insert" loses the race under concurrent workers. Two workers see the slot empty, both insert, one succeeds and one fails — and now you're catching the duplicate-key error anyway, just from a more confused starting position. Upsert is worse: it papers over the difference between *insert a new event* and *modify an existing one*, which is the exact distinction the append-only invariant is trying to preserve.

The only correct form is: try to insert; if the key collides, the receiver was idempotent and there's nothing more to do. The unique index is the durable guarantee. The narrow `catch` is the policy. The save-before-ack ordering is the protocol. All three together are what at-least-once delivery actually means in practice.

If you take one thing from this post: at-least-once is not a property of your message broker. It's a property of the *contract between your broker and your receiver.* The broker holds up its end automatically. The receiver only holds up its end if you wrote it to.
