---
id: eventhorizon-2026-07-14T0900-gke-rabbitmq-manifest
repo: eventhorizon
title: "GKE Deployment Prep (ADR 0020 + RabbitMQ Manifest)"
date: 2026-07-14
phase: 25
tags: [kubernetes, gke, rabbitmq, recreate-strategy, persistent-volumes, adr, secrets]
files: [docs/adr/0020-gke-deployment-manifest-approach-and-rabbitmq-placement.md, k3s/rabbitmq.yaml, k3s/secret.yaml]
---

### Decision: Raw Manifests Stay Raw, RabbitMQ Goes In-Cluster

Xylem-L6's ADR 0003 assumed "the same cluster and namespace pattern already planned for EventHorizon and Rhizome Lens" without ever deciding two things behind that premise for EventHorizon specifically: Helm vs. raw manifests, and where RabbitMQ lives. ADR 0020 answers both narrowly, for EventHorizon only. Raw manifests stay raw — the existing `k3s/*.yaml` files are already GKE Autopilot-compatible (declared resource requests, no restricted workload types), so introducing Helm would be solving a problem that doesn't exist yet. RabbitMQ goes in-cluster (`k3s/rabbitmq.yaml`) rather than to a managed vendor, because the DNS name `configmap.yaml` already assumes (`rabbitmq.event-horizon.svc.cluster.local`) only needs a service to exist at that address — evaluating a new vendor's free tier is out of scope for unblocking deployment today. The two services aren't equally close to deployable: EventHorizon already has raw manifests written against a local k3s target, while Rhizome Lens has no Kubernetes manifests at all yet (docker-compose only), and deciding Lens's manifest approach now would be speculative, since Lens's own Prometheus/Loki/Tempo/Grafana stack was the specific case Xylem-L6's ADR 0003 made for Helm being a good fit there — a case that stands on Lens's own merits and doesn't need to be settled to unblock EventHorizon today. Rhizome Lens's own manifest question stays open; nothing here resolves it.

### Pattern: Mirror the docker-compose Config Instead of Inventing New Config Surface

`k3s/rabbitmq.yaml`'s Deployment uses the exact same image (`rabbitmq:3-management-alpine`), the exact same three ports (5672/15672/15692), and the exact same `guest`/`guest` credentials as `docker-compose.yml`'s local `rabbitmq` service. No new credential scheme, no new port scheme — the in-cluster broker is a straight containerization of what already runs locally, which kept the manifest a small, mechanical translation rather than a fresh design exercise.

### Anti-Pattern Avoided: RollingUpdate Against a Singly-Mounted PVC

The default Deployment strategy is `RollingUpdate`, which starts the new pod before terminating the old one so there's no downtime. RabbitMQ's pod mounts a `ReadWriteOnce` PVC (`rabbitmq-data`), and with only one replica, a `ReadWriteOnce` volume can only be mounted by one pod at a time. Under `RollingUpdate`, the new pod would wait to mount the volume the old pod still holds, while the old pod waits to be told it's safe to terminate — a deadlock on every rollout. `k3s/rabbitmq.yaml` sets `strategy.type: Recreate` explicitly, which terminates the old pod first, so the volume is free before the new pod starts. This mirrors the same class of constraint MongoDB's single-node replica set already imposes locally, just surfacing here as a Kubernetes-specific rollout concern instead of a Mongo one.

### Decision: guest/guest Stays a Plain Env Var, Not a Secret, in the Deployment Itself

`rabbitmq.yaml`'s container sets `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS` as literal env values rather than pulling them from `event-horizon-secrets` — they aren't sensitive (same guest/guest as local dev, broker only reachable in-cluster via ClusterIP), so routing them through a Secret would add indirection without adding protection. `secret.yaml`'s `RABBITMQ_URL`, by contrast, does get the real base64-encoded value (`amqp://guest:guest@rabbitmq.event-horizon.svc.cluster.local:5672`) — not because the credentials are sensitive, but because that's the field the app (`config.ts`) actually reads its connection string from, so leaving it as an empty placeholder would leave the app unable to connect even though nothing about the value is secret.

### Challenge: No `kubectl` Available to Dry-Run Against a Real API Server

This environment has no `kubectl` installed, so `k3s/rabbitmq.yaml` and the updated `k3s/secret.yaml` were only validated as syntactically-correct YAML (`yaml.safe_load_all`), not schema-validated against the Kubernetes API (`kubectl apply --dry-run=server` or even `--dry-run=client`) or applied to a live k3s/GKE cluster. The manifest follows the existing `server.yaml`/`worker.yaml` structural conventions closely enough that this is a low-risk gap, but it's an unverified claim, not a confirmed one, until a cluster context is available to apply against.
