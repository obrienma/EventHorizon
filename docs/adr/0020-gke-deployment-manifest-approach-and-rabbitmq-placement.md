# ADR 0020 — GKE Deployment: Manifest Approach and RabbitMQ Placement

**Status:** Accepted

**Date:** 2026-07-14

---

## Context

Xylem-L6's ADR 0003 named "the same cluster and namespace pattern already planned for EventHorizon and Rhizome Lens" as a premise, but two decisions behind that premise were never actually made: the manifest approach (raw manifests vs. Helm) and RabbitMQ's placement (in-cluster vs. external). Both were left open pending a broader GCP integration plan.

EventHorizon already has raw manifests (`k3s/namespace.yaml`, `configmap.yaml`, `secret.yaml`, `server.yaml`, `worker.yaml`) with resource requests/limits declared, written against a local k3s target and never yet applied to GKE. Rhizome Lens, by contrast, has no Kubernetes manifests at all — still docker-compose only. That gap means the two services aren't equally close to deployable, and there's no need to resolve both services' questions together to move either one forward.

This ADR resolves both open questions **for EventHorizon specifically**, to unblock its deployment now. It does not resolve them for Rhizome Lens — Lens's manifest approach and any RabbitMQ-adjacent question (it has none directly) stay open until Lens's own deployment is picked up.

## Decision

**1. Manifest approach: raw manifests, not Helm, for EventHorizon.**

The existing `k3s/*.yaml` files are the manifests. They're GKE Autopilot-compatible as written — Autopilot enforces declared resource requests, which these already have, and restricts a handful of workload types (DaemonSets, hostPath volumes) that none of these manifests use. No Helm chart is introduced for EventHorizon.

This doesn't decide Rhizome Lens's manifest approach. ADR 0003's (Xylem-L6) original rationale for GKE placement specifically called Lens's Prometheus/Loki/Tempo/Grafana stack "one of the most common real-world Helm-chart deployment patterns there is" — that case was made on Lens's own merits and stays open for when Lens deployment is actually picked up, independent of this decision.

**2. RabbitMQ placement: in-cluster, in the `event-horizon` namespace.**

A new manifest, `k3s/rabbitmq.yaml`, adds a single-replica Deployment + PersistentVolumeClaim + ClusterIP Service named `rabbitmq`, matching the DNS name `configmap.yaml` already assumes (`rabbitmq.event-horizon.svc.cluster.local`). No changes to `configmap.yaml`'s structure — only real credential values are needed in `secret.yaml` once the service exists.

## Rationale

In-cluster RabbitMQ keeps the DNS name the existing manifests already assume valid, without touching a file that's already correct. It's one new manifest, not a new vendor account or free-tier evaluation, and it mirrors what `docker-compose.yml` already runs locally — same image (`rabbitmq:3-management-alpine`), same ports, just containerized in the cluster instead of on the dev machine.

An external managed RabbitMQ (e.g. CloudAMQP) was considered and may be a reasonable long-term choice, but evaluating a new vendor's free-tier limits is exactly the scope this decision doesn't need to take on to unblock deployment today. Nothing about EventHorizon's current single-node RabbitMQ hurts yet — the same "wait until it hurts" reasoning that's shaped every other infra decision in the suite applies here too.

Single-replica, not HA, mirrors the resource-conscious posture already declared in `server.yaml`/`worker.yaml` (100m–256m CPU, 64Mi–256Mi memory per container). A demo-scale deployment doesn't need RabbitMQ HA, and adding it now would be the same kind of speculative complexity the suite has named and rejected elsewhere.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| External managed RabbitMQ (CloudAMQP free tier) | No PVC/storage to manage in-cluster; matches the free-tier-first pattern used elsewhere (Upstash, Neon, Cloudflare R2) | New vendor evaluation; changes the DNS/URL values in already-correct config; adds an external dependency for no problem currently felt |
| RabbitMQ via a published Helm chart (e.g. Bitnami) | Production-grade configuration out of the box | Reintroduces the Helm question this ADR specifically keeps off EventHorizon's raw-manifest path; far more configuration surface than a single-replica demo needs |
| Defer RabbitMQ placement further, leave EventHorizon deployment blocked | Avoids deciding under time pressure | This is the exact decision that's been open since Xylem-L6's ADR 0003 was drafted; EventHorizon's own manifests already assume an answer (cluster-local DNS) that's simply never been fulfilled |

## Consequences

- `k3s/rabbitmq.yaml` needs to be written — Deployment, PVC, Service — a small, well-specified addition; image and ports are already known from `docker-compose.yml`.
- `k3s/secret.yaml`'s `RABBITMQ_URL` needs real base64-encoded credentials pointing at the in-cluster service once `rabbitmq.yaml` exists.
- This ADR resolves EventHorizon's RabbitMQ placement only. Xylem-L6 doesn't use RabbitMQ (Pub/Sub, per its own ADR 0003), so this doesn't apply there. Rhizome Lens's placement question, if it has one, is unaddressed and separate.
- GKE Autopilot bills the RabbitMQ pod's requested CPU/memory/storage like any other workload — no fee is waived here, unlike the cluster management fee itself (noted in Xylem-L6's ADR 0003).
- EventHorizon can proceed to actual GKE deployment once `rabbitmq.yaml` is built; Rhizome Lens and Xylem-L6 remain gated on their own separate, still-open decisions.
