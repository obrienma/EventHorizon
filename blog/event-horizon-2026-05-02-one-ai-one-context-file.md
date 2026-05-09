---
title: "One AI, One Context File"
date: 2026-05-02
tags: [event-horizon, claude, ai, workflow, adr]
summary: I started this project with two AI assistants and a sync problem. I'm finishing it with one assistant and three documents that act as the project's durable memory. Here's what changed.
---

EventHorizon began as a *dual-LLM* project. Claude Code as the primary pair, with `CLAUDE.md` at the project root holding context for it. GitHub Copilot in the editor, with `.github/copilot-instructions.md` mirroring the same context. Two assistants, two context files, one rule: keep them in sync.

I am ending this project with one assistant and one context file. The Copilot file still exists in the repo as a historical artifact, but it hasn't been updated in months and I've stopped looking at it. I want to write up the workflow shift, because the journey from "two AIs" to "one AI, three documents" turned out to be the more interesting story than the AI-tooling-comparison post I'd originally meant to write.

## What dual-LLM was supposed to give me

Two complementary working modes. Copilot for in-editor suggestions while typing — the autocomplete-on-steroids loop, fast feedback, low ceremony. Claude Code for harder questions: design choices, cross-file refactors, debugging stuck threads. The pitch was that the two assistants would cover different parts of the work, with the shared `CLAUDE.md`/`copilot-instructions.md` ensuring they had the same understanding of the project.

It worked, in the sense that it didn't actively break. It also gave me three things I didn't anticipate.

**A sync tax.** Every time I updated `CLAUDE.md` — adding a build-status note, refining an invariant, recording a new decision — I had to remember to mirror the same change into `copilot-instructions.md`. I forgot, often. Within two weeks the files had drifted. By a month, the Copilot file was describing an older version of the project. By two months, I had stopped opening it.

**A reasoning gap.** The two assistants were not equally good at the same things. Copilot's suggestions were tactical, line-level, helpful for boilerplate. They were not helpful when I needed to reason about ordering in the shutdown sequence, or whether a refactor was structurally safe, or *why* a test was lying about its dependencies. Claude Code was where the design conversations happened — and once the design was settled, the implementation was usually short enough that I didn't need autocomplete to move fast.

**Cognitive overhead.** Choosing which assistant to ask is itself a small task. "Is this a Copilot question or a Claude Code question?" is one more decision per loop. Multiplied across a session, it added friction without adding clarity.

## What changed

Around the time I added the change-stream resume token recovery, I noticed I'd done the entire feature — design, implementation, tests, ADR — through Claude Code, with Copilot's suggestions ignored. The pattern had been gradual: my Claude Code sessions had grown longer and more structured; my use of Copilot had quietly evaporated.

I disabled Copilot in this repo. I left the instructions file as an artifact (deleting it would have been more decisive but felt unnecessarily nuclear). I haven't missed it. The work is faster, not slower, with one assistant — because the cognitive overhead of choosing was real and the productivity gain from autocomplete was, for me, smaller than I'd assumed.

This is not a knock on Copilot. It's a knock on *me using two tools when the second tool isn't pulling its weight in this specific workflow.* For someone writing a lot of repetitive boilerplate (a CRUD API across many entities, say), autocomplete is hugely helpful. EventHorizon doesn't have much repetitive code; it has a small number of carefully-considered modules. The work I do most is reasoning, not typing.

## What replaced "keep two files in sync"

Three documents now do the job of "the project's durable memory":

**`CLAUDE.md`.** The standing instructions and context. Architecture invariants, stack, build status, workflow rules. This is the file Claude Code reads on every session, so it has to be tight, current, and prescriptive. It doesn't tell stories — it states rules. *"Append-only storage: MongoDB documents are NEVER updated after insert."* That's the entire append-only invariant; no debate, no history, just the rule.

**`docs/adr/` (architecture decision records).** Every non-trivial design choice gets one. Numbered, dated, status-stamped (Accepted, Deferred, Superseded). The ADR is where the *reasoning* lives — the alternatives considered, the rationale, the consequences, the trade-offs accepted. ADR 0011 has the change-stream resume token recovery story. ADR 0012 has the Zod-vs-Valibot comparison. When future me wonders "why did we do this?", the answer is in `docs/adr/NNNN-thing.md` and only there.

**`LEARNING_LOG.md`.** Personal study notes generated during the build. Organised by phase, structured as named patterns, anti-patterns, challenges, and decisions. Each entry has flashcard-format `Q:` / `A:` blocks for spaced repetition later. This is the file I write *for me* — it's not for the assistant, it's not for collaborators, it's for the version of me who comes back in a year and needs to remember why `nack(msg, false, true)` is the wrong answer.

The three documents have non-overlapping jobs. CLAUDE.md is *prescriptive* (what to do). ADRs are *deliberative* (why we chose to do it this way). The LEARNING_LOG is *reflective* (what I learned along the way). Together they cover the project's memory comprehensively without any one of them having to do everything.

## What CLAUDE.md does that no doc had done before

I want to single out one section of `CLAUDE.md`, because it's the single most useful thing I added: the **Hard Invariants** list.

```markdown
## Hard Invariants — Never Violate These

- Append-only storage: MongoDB documents are NEVER updated after insert.
- Idempotent inserts: unique index on `{ "raw.id": 1 }`. Duplicate key errors
  (code 11000) are silently ignored — not re-thrown.
- AppEvent is the shared contract: all planes import event types from
  src/ingestion/event.schema.ts.
- z.infer<> only: types are always derived from Zod schemas.
- Graceful shutdown order: Fastify stop → cancel AMQP consumer → finish
  in-flight message → close change stream → close MongoDB → close AMQP
  channel + connection → process.exit(0).
```

These are five sentences that a competent contributor (human or AI) needs to internalise *before writing a single line of code in this project.* They're not implementation details — they're rules that, if violated, produce specific named bugs that this entire codebase was designed to prevent.

Before I had this list, I'd find myself re-explaining the same invariants to Claude Code in every session. *"Remember, append-only — don't reach for `updateOne` here."* *"Idempotent receivers — silently swallow 11000."* It was a reliable, recurring conversation. Once I wrote the list, the invariants became part of the standing context. The recurring explanation stopped happening. Sessions started one step closer to the actually-interesting question.

The general principle: **anything you find yourself re-explaining is a candidate for the standing context.** The standing context isn't documentation in the human-reading sense; it's *the knowledge the assistant needs to skip the orientation phase and start being useful.*

## The ADR habit

The ADR practice is the other half of the workflow shift, and it's the one I'd recommend most strongly to anyone working with an AI assistant on a long-lived project.

The pattern: any time I make a non-trivial design choice — pick a library, change a topology, defer a feature — I write an ADR. Numbered. Dated. With Context, Decision, Rationale, Alternatives Considered, Consequences. It takes 15-30 minutes per ADR, which is short enough that I'll actually do it but long enough to force me to articulate the reasoning rather than just record the conclusion.

There are now twelve ADRs in this project. Each one captures a decision that would otherwise live in my head, or — worse — be recoverable only by reading the code and guessing. The ADRs aren't long. They aren't comprehensive. They are *the answer to the question "why is this done this way?"* in writing, the day the decision was made, while the trade-offs were still vivid.

This pays off in two ways.

**Personal:** when I come back to a part of the system months later, the ADR tells me what past-me was thinking when current-me makes a decision. Without it, I'd be reverse-engineering my own reasoning from the code, which is slower and lossier than just reading the doc.

**With the assistant:** when I ask Claude Code about a part of the system, I can drop the relevant ADR into the conversation. The assistant immediately has my reasoning, my alternatives, my trade-offs. It doesn't have to guess at intent from the code alone. The conversations get sharper because the context is richer.

Without ADRs, the assistant has to reconstruct intent from code-only signals — variable names, comments, commit messages — and "why was this done this way?" becomes a guessing game. With ADRs, the answer is in the conversation immediately. The assistant works *from* my reasoning rather than *toward* it.

## What I'd do differently

Two things, looking back at the dual-LLM start.

**I'd skip the dual setup from day one.** The cost was the sync tax and the reasoning-gap; the benefit (autocomplete-style suggestions) was worth less to me than I'd estimated. For a project with a clear architectural shape and a small surface area, one assistant with deep context beats two assistants with shallow context every time. If autocomplete-style suggestions are a load-bearing part of your workflow, that's fine — but recognise that as a separate need, not as a "second pair" need.

**I'd start the ADR habit on day one.** The first three or four ADRs in this project were written retroactively, weeks after the decision they documented. They're fine, but they're a little less alive than the ones I wrote on the day. The cost of writing an ADR while the decision is fresh is low; the cost of reconstructing one later is high; the cost of *not having one at all* and only learning that you need it when something breaks is the highest of the three.

## The deeper pattern

What I think is actually going on, beyond the specifics of which AI tool to use:

An AI assistant is a force multiplier on whatever context you give it. *Bad context: shallow, contradictory, scattered, out of date.* The assistant produces shallow, contradictory, scattered work. *Good context: tight, consistent, complete, current.* The assistant produces sharp, consistent, complete work.

The work of "keeping the assistant useful" is not about prompt engineering. It's about *maintaining the project's documented memory* so that when the assistant arrives, it can read in. The CLAUDE.md, the ADRs, the LEARNING_LOG — these are the project's memory written down, and the AI assistant is one of several consumers of that memory. (Future me is another. Collaborators are another. Each of them benefits from the same artifacts.)

Two AIs, two context files, was a tax on the wrong dimension. The improvement wasn't "switch to one AI." It was *invest more in the documented memory and let any consumer of that memory — AI or human — benefit.* I removed an AI; I added an ADR practice and a learning log. The second move mattered far more than the first.

## What's still on the file system

`.github/copilot-instructions.md` is still there. I haven't deleted it. It's outdated and inert and harms nothing. Maybe I'll delete it in a future cleanup pass; maybe I'll leave it as evidence of the path I took. Either way, it stopped being load-bearing the day the sync tax outweighed the autocomplete benefit, and that day was earlier than I admitted to myself.

One AI. One context file (plus the ADRs and the learning log, which are *for me* but also useful to the AI). One sync target. One source of truth. The simplest workflow that does the job, which turns out to be the right amount of tooling for this project.

If I ever start another project, I'm starting with this configuration. The dual-LLM thing was an experiment. The result of the experiment was: one is enough.
