---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-27, kubernetes, networking, adr]
---
Q: The investigation behind ADR 0023 confirmed *that* Cloud NAT breaks GKE-to-Atlas connectivity, but never confirmed *why*. Why did the decision proceed anyway, rather than continuing to investigate the exact mechanism?

A: A temporary GKE Standard cluster with nodes given direct external IPs — structurally removing Cloud NAT from the path entirely, with no other change — connected to Atlas successfully on the first attempt, using the same app image, driver, and Atlas cluster that had failed 100% of the time through NAT. That's sufficient evidence to act on: removing the dependency on Cloud NAT sidesteps the failure regardless of its exact internal mechanism, whereas continuing to investigate would be chasing a specific fix for an unconfirmed cause, with no guarantee of finding one, against a free alternative (in-cluster MongoDB) that was already known to work.

Extra: EventHorizon · Phase 27 · Decision: Sidestep Cloud NAT Rather Than Chase Its Exact Failure Mechanism
See: docs/journal/eventhorizon-2026-07-19T0900-in-cluster-mongodb.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-27, config, mongodb]
---
Q: ADR 0023 reverses ADR 0021's MongoDB Atlas decision back to in-cluster MongoDB. Why did this require zero changes to `src/config.ts`?

A: ADR 0021 (Phase 26) had already made `config.ts`'s Mongo schema accept either a full `MONGO_URI` string or three discrete Atlas credential fields (`MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD`), specifically to preserve support for the unauthenticated local docker-compose database alongside the new Atlas path. In-cluster MongoDB is unauthenticated, so it's exactly the `MONGO_URI`-only shape that code path already supported — the reversal only needed `k3s/configmap.yaml` to set `MONGO_URI` to the in-cluster Service DNS name and `k3s/secret.yaml` to drop the now-unused `MONGO_PASSWORD` field.

Extra: EventHorizon · Phase 27 · Decision: No Code Changes — the Unauthenticated MONGO_URI Path Already Existed
See: docs/journal/eventhorizon-2026-07-19T0900-in-cluster-mongodb.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-27, adr, convention]
---
When ADR 0023 superseded ADR 0021, the project's convention of {{c1::never editing an accepted ADR's body text}} was followed by adding {{c2::a "Superseded by" line under ADR 0021's Status header}} pointing at ADR 0023, rather than rewriting ADR 0021's Context/Decision/Rationale to match the new choice — because ADR 0021's reasoning was {{c3::an accurate record of the information available at the time, not a mistake}}.

Extra: EventHorizon · Phase 27 · Anti-Pattern Avoided: Editing an Accepted ADR's Body Text
See: docs/journal/eventhorizon-2026-07-19T0900-in-cluster-mongodb.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-27, git, secrets]
---
Q: `.gitignore` had listed `k3s/secret.yaml` since Phase 26, but `git status` still showed it as a modifiable, stageable file in Phase 27. What was the actual gap, and what fixed it?

A: Phase 26 added the `.gitignore` rule and created `k3s/secret.example.yaml` as a new tracked template, but never ran `git rm --cached k3s/secret.yaml` — so the original file, tracked since Phase 14, stayed tracked. A `.gitignore` entry only stops *new* files from being added; it has no effect on a file git is already tracking. That left real credentials filled into the local file sitting in `git status` as a committable change. Fixed with `git rm --cached k3s/secret.yaml`, which untracks the file in git while leaving it on disk.

Extra: EventHorizon · Phase 27 · Challenge: A Previously-Gitignored Secret File Was Still Tracked in Git
See: docs/journal/eventhorizon-2026-07-19T0900-in-cluster-mongodb.md
