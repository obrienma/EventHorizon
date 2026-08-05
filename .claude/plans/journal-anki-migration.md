# Plan: Migrate EventHorizon's journal to the journal-anki convention

## Context (why this exists)

Sentinel-l7's `docs/journal.md` (single-file, phase-numbered) was just migrated to the journal-anki skill's per-entry convention (`docs/journal/<id>.md` + `docs/probes/<id>.md`), matching Ledger-L5/Xylem-L6/synapse-l4/arbiter-l8. That migration is **done and verified** — treat it as the concrete template for this one. Its journal entries live at `~/dev/sentinel-l7/docs/journal/sentinel-l7-*.md` if you want a live example of the target frontmatter/body shape.

This plan does the same thing for `~/dev/EventHorizon/`. The user asked to do sentinel-l7 first, review, then EventHorizon — sentinel-l7 is done; this session was cleared before EventHorizon started, so this file carries all the research/decisions forward.

The skill spec is `~/.claude/skills/journal-anki/SKILL.md` — read it first (sections 1, 2, 3 "Retroactive migration" matter most).

## Decisions already made (do not re-ask)

- **Full retroactive migration**, not just wiring — split the legacy file into per-entry files now.
- **Regenerate/rename probes to match new ids too** (not left on old naming), even though this risks needing an Anki resync — user explicitly accepted this for sentinel-l7 and it applies here too.
- **Timestamp derivation**: prefer a real git commit timestamp (via `git log -1 --format='%cI' <hash>`) wherever a commit hash is discoverable; otherwise use the entry's header date with a synthetic same-day HHMM sequence (0900, 0915, 0930...) to preserve relative phase ordering within a shared date.
- **Generate new probe cards** (don't just skip) for any entry that currently has zero Anki coverage — apply the skill's §4 note-type decision procedure fresh for those.
- **Legacy cleanup**: once new files are verified good, delete the superseded source file(s) and old probe files (git-tracked, so recoverable via history). Same was done for sentinel-l7: deleted `docs/journal.md`, all 22 old `docs/probes/phase-N-*.md`, and a 185KB `LEARNING_LOG.md` that the journal itself had already called superseded.
- **Delegate the mechanical generation to a background Agent** once the id/timestamp mapping is fully worked out — this is well-specified execution, not a judgment task, and the source files are large (EventHorizon's `docs/journal.md` is 1337 lines). Then **verify the agent's output yourself** before reporting done (check file counts, frontmatter YAML validity, id==filename, no stale `See:` refs) — don't trust the summary alone. See sentinel-l7's session transcript for the exact verification commands used (frontmatter YAML parse + id/filename/cross_ref consistency check, card-count check, stale-reference grep).

## Full entry mapping (already derived — do not re-derive)

EventHorizon's `docs/journal.md` has **31 entries** (phase numbering is reused/non-monotonic: three separate "Phase 3" sections, two separate "Phase 8" sections, and no "Phase 5" at all — this is real, not a misread). 29 of them already have a matching probe file in `docs/probes/`; 2 do not (flagged below).

Only one commit hash is cited anywhere in the source text (`a9e2e4a`, mentioned in prose in the Phase 16 entry, not in a structured "Commits:" line) — verified via `git log -1 --format='%cI' a9e2e4a` → `2026-06-14T18:26:52-07:00`, matching a real commit `fix(ingestion): stringify request.body before Buffer.byteLength`. Used for entry 18 below. Every other entry uses the synthetic same-day sequencing fallback.

Repo's current branch is `prep`, not `master` — not itself an issue, just don't assume `master` when running git commands here.

| # | Journal header (as written) | Date | New id | Existing probe file (old name) |
|---|---|---|---|---|
| 1 | Phase 1 — Foundation | 2026-03-26 | `eventhorizon-2026-03-26T0900-foundation` | `phase-1-foundation.md` |
| 2 | Phase 2 — Server Skeleton + Ingestion Route | 2026-03-26 | `eventhorizon-2026-03-26T0915-server-skeleton` | `phase-2-server-skeleton.md` |
| 3 | Phase 3 — Processing Plane: RabbitMQ Topology + publishEvent | 2026-03-27 | `eventhorizon-2026-03-27T0900-rabbitmq-topology` | `phase-3-rabbitmq-topology.md` |
| 4 | Phase 3 — Processing Plane: Worker + Processors | 2026-03-27 | `eventhorizon-2026-03-27T0915-worker-processors` | `phase-3-worker-processors.md` |
| 5 | Phase 3 — Storage Plane | 2026-03-28 | `eventhorizon-2026-03-28T0900-storage-plane` | `phase-3-storage-plane.md` |
| 6 | Phase 4 — Observation Plane | 2026-03-28 | `eventhorizon-2026-03-28T0915-observation-plane` | `phase-4-observation-plane.md` |
| 7 | Phase 6 — Bug Fix: Zod v4 UUID Validation | 2026-03-28 | `eventhorizon-2026-03-28T0930-zod-uuid-bugfix` | `phase-6-zod-uuid-bugfix.md` |
| 8 | Phase 7 — Concepts: Node.js Event Loop Handle Ref-Counting | 2026-03-29 | `eventhorizon-2026-03-29T0900-event-loop-refcounting` | `phase-7-event-loop-refcounting.md` |
| 9 | Phase 8 — Bug Fix: Credentials in fetch URLs | 2026-03-29 | `eventhorizon-2026-03-29T0915-fetch-credentials-bugfix` | `phase-8-fetch-credentials-bugfix.md` |
| 10 | Phase 9 — Change Stream Resume Token Recovery | 2026-04-01 | `eventhorizon-2026-04-01T0900-resume-token-recovery` | `phase-9-resume-token-recovery.md` |
| 11 | Phase 8 — Testability Refactor: App Factory | 2026-04-25 | `eventhorizon-2026-04-25T0900-app-factory` | `phase-8-app-factory.md` |
| 12 | Phase 10 — Bug Fix: Silent Message Drop Under Flow Control | 2026-05-14 | `eventhorizon-2026-05-14T0900-silent-message-drop` | `phase-10-silent-message-drop.md` |
| 13 | Phase 11 — Durable Resume Token Checkpoint | 2026-06-03 | `eventhorizon-2026-06-03T0900-durable-checkpoint` | `phase-11-durable-checkpoint.md` |
| 14 | Phase 12 — Dockerfile | 2026-06-03 | `eventhorizon-2026-06-03T0915-dockerfile` | `phase-12-dockerfile.md` |
| 15 | Phase 13 — Health Check Endpoint | 2026-06-03 | `eventhorizon-2026-06-03T0930-health-check` | `phase-13-health-check.md` |
| 16 | Phase 14 — k3s Manifests | 2026-06-03 | `eventhorizon-2026-06-03T0945-k3s-manifests` | `phase-14-k3s-manifests.md` |
| 17 | Phase 15 — OTel Instrumentation *(cross_ref: observability)* | 2026-06-06 | `eventhorizon-2026-06-06T0900-otel-instrumentation` | `phase-15-otel-instrumentation.md` |
| 18 | Phase 16 — Live OTel Validation *(cross_ref: observability)* | 2026-06-14 | `eventhorizon-2026-06-14T1826-live-otel-validation` **(real commit time, see above)** | `phase-16-live-otel-validation.md` |
| 19 | Phase 17 — Fault Injection for Dashboard Visuals *(cross_ref: observability)* | 2026-06-14 | `eventhorizon-2026-06-14T1900-fault-injection` | `phase-17-fault-injection.md` |
| 20 | Phase 18 — Custom OTel Metrics *(cross_ref: observability)* | 2026-06-15 | `eventhorizon-2026-06-15T0900-custom-otel-metrics` | `phase-18-custom-otel-metrics.md` |
| 21 | Phase 19 — Completing Intentional-Friction TODOs | 2026-06-15 | `eventhorizon-2026-06-15T0915-todo-completion` | `phase-19-todo-completion.md` |
| 22 | Phase 20 — Bounded WebSocket Backpressure *(cross_ref: observability)* | 2026-07-04 | `eventhorizon-2026-07-04T0900-bounded-websocket-backpressure` | `phase-20-bounded-websocket-backpressure.md` |
| 23 | Phase 21 — GraphQL Query API, Phase 0 (Scaffold) | 2026-07-06 | `eventhorizon-2026-07-06T0900-graphql-scaffold` | **none — see note A** |
| 24 | Phase 22 — GraphQL Query API, Phase 1 (Real Schema/Resolvers) | 2026-07-06 | `eventhorizon-2026-07-06T0915-graphql-resolvers` | `phase-22-graphql-resolvers.md` |
| 25 | Phase 23 — GraphQL Query API, Phase 2 (pipelineRuns + DataLoader) | 2026-07-06 | `eventhorizon-2026-07-06T0930-dataloader-n-plus-1` | `phase-23-dataloader-n-plus-1.md` |
| 26 | Phase 24 — GraphQL Query API, Phase 3 (ADR Closeout) | 2026-07-06 | `eventhorizon-2026-07-06T0945-graphql-adr-closeout` | **none — see note B** |
| 27 | Phase 25 — GKE Deployment Prep (ADR 0020 + RabbitMQ Manifest) | 2026-07-14 | `eventhorizon-2026-07-14T0900-gke-rabbitmq-manifest` | `phase-25-gke-rabbitmq-manifest.md` |
| 28 | Phase 26 — MongoDB Atlas Config + RabbitMQ Credential Split (ADR 0021) | 2026-07-14 | `eventhorizon-2026-07-14T0915-mongodb-atlas-config` | `phase-26-mongodb-atlas-config.md` |
| 29 | Phase 27 — In-Cluster MongoDB, Reversing ADR 0021 (ADR 0023) | 2026-07-19 | `eventhorizon-2026-07-19T0900-in-cluster-mongodb` | `phase-27-in-cluster-mongodb.md` |
| 30 | Phase 28 — First GKE Deployment: Branch Trigger, Probe Tuning, Build Gap | 2026-07-19 | `eventhorizon-2026-07-19T0915-gke-first-deployment` | `phase-28-gke-first-deployment.md` |
| 31 | Phase 29 — MongoDB Atlas Connectivity: Full-Day Elimination Ending in Cloud NAT | 2026-07-19 | `eventhorizon-2026-07-19T0930-atlas-connectivity` | `phase-29-atlas-connectivity.md` |

**Note A (entry 23, GraphQL scaffold):** the journal text itself says "No probe entry was written for this phase, per the plan's own instruction to only document the scaffold step if it wasn't a straight line." Per the user's decision to generate new cards for gaps, produce a small probe anyway (a couple of cards on the Apollo/Fastify integration boot-check pattern), but this is a legitimate case where a thin probe is appropriate — don't pad it.

**Note B (entry 26, GraphQL ADR closeout):** journal text says "The probe file for the DataLoader mechanism was already written during Phase 2 ... it didn't need a separate closeout probe." Use judgment: either a very small probe on the "close an ADR with measured numbers, not just a status flip" decision, or note in the migration report that this entry deliberately has no dedicated probe and cross-references entry 25's. Don't force padding either way.

## Known discrepancy to flag, not silently fix

EventHorizon's `docs/journal.md` header (lines 3-4) claims cross-cutting entries are mirrored to `\\wsl$\Ubuntu\home\amanda\dev\rhizome-observability\docs\journal.md` (a single legacy file path). **This pointer is already known to be dead**: sentinel-l7's migration (same session, already done) checked `rhizome-observability/` directly and found it has no `docs/` directory at all — not even a legacy `docs/journal.md`. So there is no mirror for any of EventHorizon's 5 cross_ref entries (17-20, 22 in the table above) either. Confirm this again for EventHorizon specifically (don't just assume it's identical) and report it as a reconciliation gap — do not create a mirror file yourself.

## CLAUDE.md wiring — unfinished, pick up here

This session got interrupted mid-read of `~/dev/EventHorizon/CLAUDE.md` before checking it fully. What's already known (from an earlier grep this session): it has a `## Journal` section around lines 131-139 describing EventHorizon's *own* bespoke convention (single `docs/journal.md`, `docs/probes/phase-N-<name>.md`, cross-cutting entries pointed at `rhizome-observability`) — it does **not** reference the journal-anki skill by name or path at all. This was flagged earlier in this same session (before the sentinel-l7 work) as a real gap: EventHorizon's CLAUDE.md wiring doesn't match what the skill's "Required CLAUDE.md wiring" section requires in substance.

Also confirmed this session: `~/dev/EventHorizon/LEARNING_LOG.md` **still exists on disk**, and `docs/journal.md` itself says "LEARNING_LOG.md has been migrated and superseded by docs/journal.md + docs/probes/" — same pre-existing drift pattern as sentinel-l7 had (CLAUDE.md workflow notes possibly still stale re: LEARNING_LOG.md; needs a full read of CLAUDE.md to confirm one way or the other before editing).

Next-session steps for this part:
1. Read `~/dev/EventHorizon/CLAUDE.md` in full.
2. Replace the bespoke `## Journal` section with the same "Journal (journal-anki)" wording used in sentinel-l7/Ledger-L5/Xylem-L6 (pointing at `~/.claude/skills/journal-anki/SKILL.md`), removing the stale rhizome-observability mirror-path claim.
3. If CLAUDE.md separately instructs maintaining `LEARNING_LOG.md` anywhere else (workflow notes section, etc.), fix that too, same as sentinel-l7.

## Execution steps for next session

1. Read `~/dev/EventHorizon/CLAUDE.md` fully (see above).
2. Delegate the mechanical migration to a background Agent, same shape as the sentinel-l7 prompt: give it this file's full mapping table verbatim, the source files to read (`docs/journal.md`, `docs/probes/*.md`), the target frontmatter schema (see any `~/dev/sentinel-l7/docs/journal/sentinel-l7-*.md` file as a live example), the two probe-gap notes (A and B above), and explicit instructions not to touch CLAUDE.md (handle that yourself) and not to delete any original files (handle cleanup yourself after verifying).
3. Verify the agent's output: file counts (should be 31 journal + 31 probe files, or 30 if entry 26 ends up cross-referenced instead of getting its own probe — confirm which), frontmatter YAML parses, `id` matches filename, `cross_ref`/`cross_ref_id` present only on the 5 flagged entries, no leftover `See: docs/journal.md` references in any new probe file.
4. Fix CLAUDE.md wiring (see above).
5. Ask the user about deleting the legacy `docs/journal.md`, the 29 old probe files, and `LEARNING_LOG.md` — same three-option pattern used for sentinel-l7 (delete all now / keep everything / delete only LEARNING_LOG.md).
6. Draft a commit message in the `docs(journal): ...` style used for the sentinel-l7 commit (see that commit message for the exact tone/format) — do not commit unless explicitly asked.
