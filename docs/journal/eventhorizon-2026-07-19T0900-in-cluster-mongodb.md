---
id: eventhorizon-2026-07-19T0900-in-cluster-mongodb
repo: eventhorizon
title: "In-Cluster MongoDB, Reversing ADR 0021 (ADR 0023)"
date: 2026-07-19
phase: 27
tags: [mongodb, gke, cloud-nat, kubernetes, adr, git]
files: [docs/adr/0023-in-cluster-mongodb-reversing-adr-0021.md, docs/adr/0021-mongodb-atlas-over-in-cluster-mongodb.md, k3s/mongodb.yaml, k3s/configmap.yaml, k3s/configmap.example.yaml, k3s/secret.yaml, k3s/secret.example.yaml]
---

### Decision: Sidestep Cloud NAT Rather Than Chase Its Exact Failure Mechanism

A full day of investigation established that GKE pods can't reach MongoDB Atlas through Cloud NAT — every attempt failed identically with `SSL routines:ssl3_read_bytes:tlsv1 alert internal error` immediately after `ClientHello`, and a temporary GKE Standard cluster with nodes given direct external IPs (structurally removing Cloud NAT from the path) connected on the first attempt with no other change — without ever establishing why Cloud NAT specifically breaks it. That's sufficient evidence to act on: removing the dependency on Cloud NAT sidesteps the failure regardless of its exact internal mechanism, whereas continuing to investigate would be chasing a specific fix for an unconfirmed cause, with no guarantee of finding one, against a free alternative (in-cluster MongoDB) that was already known to work. Atlas private connectivity (VPC Peering/PSC/PrivateLink) would sidestep NAT directly but requires M10+ (~$57+/month), breaking this project's free-tier-first posture for an unconfirmed fix. ADR 0023 removes the dependency on Cloud NAT entirely: pod-to-pod traffic to an in-cluster MongoDB Service never routes through it, regardless of what NAT is actually doing to the TLS handshake.

### Pattern: Mirror the Same-Phase-25 RabbitMQ Shape for a New Stateful Service

`k3s/mongodb.yaml` is a near-mechanical copy of `k3s/rabbitmq.yaml`'s structure — single-replica Deployment + `ReadWriteOnce` PVC + ClusterIP Service, `strategy.type: Recreate` for the same singly-mounted-PVC deadlock reason. Having already solved "how does a stateful in-cluster service look in this repo" once, the second instance of the same problem needed no new design, just the same shape applied to `mongo:7 --replSet rs0 --bind_ip_all` instead of `rabbitmq:3-management-alpine`.

### Decision: No Code Changes — the Unauthenticated `MONGO_URI` Path Already Existed

ADR 0021's own `config.ts` schema (Phase 26) already accepted a full `MONGO_URI` as one of its two valid shapes, specifically to support the unauthenticated local docker-compose database. Reversing back to in-cluster MongoDB reuses that exact shape rather than reopening `config.ts` — `k3s/configmap.yaml` now sets `MONGO_URI` directly to the in-cluster Service DNS name, and `MONGO_PASSWORD` is deleted from `k3s/secret.yaml`/`secret.example.yaml` since there's no longer a credential to hold. In-cluster MongoDB is unauthenticated, so it's exactly the `MONGO_URI`-only shape that code path already supported — the reversal only needed the manifest and config values to change, not `config.ts` itself.

### Anti-Pattern Avoided: Editing an Accepted ADR's Body Text

ADR 0021 remains factually accurate as a record of the reasoning available on 2026-07-14 — it wasn't a bad decision, it was overtaken by an Atlas-connectivity failure this ADR had no way to anticipate. Per this project's convention of never editing an accepted ADR's body text, its body wasn't rewritten to match the new decision; instead, a `Superseded by` line was added right under its `Status: Accepted` header, pointing at ADR 0023, leaving the original Context/Decision/Rationale intact as history.

### Challenge: A Previously-Gitignored Secret File Was Still Tracked in Git

`.gitignore` had listed `k3s/secret.yaml` since Phase 26, but `git status` still showed it as a modifiable, stageable file. Phase 26 added the `.gitignore` rule and created `k3s/secret.example.yaml` as a new tracked template, but never ran `git rm --cached k3s/secret.yaml` — so the original file, tracked since Phase 14, stayed tracked. A `.gitignore` entry only stops new files from being added; it has no effect on a file git is already tracking. That left real credentials filled into the local file sitting in `git status` as a committable change. Fixed with `git rm --cached k3s/secret.yaml`, which untracks the file in git while leaving it on disk.
