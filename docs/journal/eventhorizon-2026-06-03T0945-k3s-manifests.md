---
id: eventhorizon-2026-06-03T0945-k3s-manifests
repo: eventhorizon
title: "k3s Manifests"
date: 2026-06-03
phase: 14
tags: [k3s, configmap, secret, least-privilege, competing-consumers, single-consumer-queue, nodeport, ingress]
files: [k3s/namespace.yaml, k3s/configmap.yaml, k3s/secret.yaml, k3s/server.yaml, k3s/worker.yaml]
---

### Pattern: ConfigMap + Secret Separation

ConfigMaps are stored plaintext in etcd and visible to anyone with `kubectl get configmap`. Secrets are base64-encoded in etcd — not encrypted by default, but can be encrypted at rest with a KMS provider — and have separate RBAC controls. The separation enforces the principle of least privilege: ops tooling that reads ConfigMaps to inspect topology config does not automatically get access to database credentials. `MONGO_URI` and `RABBITMQ_URL` contain passwords, so they belong in a Secret; exchange names, thresholds, and intervals are non-sensitive and belong in a ConfigMap.

### Pattern: Competing Consumers at the Deployment Level

The worker Deployment is set to `replicas: 2`. RabbitMQ distributes messages round-robin across all consumers registered on the queue, so two worker replicas means two concurrent consumers, each processing up to `WORKER_PREFETCH` messages in parallel — double the throughput of a single replica. This is safe because the storage layer is an idempotent receiver: the unique index on `raw.id` ensures that if two workers race to insert the same event (e.g. due to a broker redeliver), one write succeeds and the other is silently swallowed (error 11000). The Competing Consumers pattern was the design goal; the architecture was built to support it from phase one.

### Anti-Pattern Avoided: Single-Replica Worker Bottleneck (Single-Consumer Queue)

Leaving `replicas: 1` on the worker Deployment creates a single point of failure and a throughput ceiling. If the worker is slow or briefly unhealthy, the queue depth climbs. With the idempotent insert already in place, there is no correctness reason to restrict to one replica. The pattern name for this anti-pattern is Single-Consumer Queue — it converts a scalable message queue into a serialised work queue.

### Decision: NodePort for Development, Ingress for Production

The server Service uses `type: NodePort` (port 30080). NodePort makes the service reachable from the host machine without configuring an Ingress controller, which is useful for local k3s development. In production, `type: ClusterIP` with an Ingress resource (Traefik, which ships with k3s by default, or nginx-ingress) would be used instead. The Ingress layer adds TLS termination, virtual hosting, and path-based routing — none of which are needed for a development-first learning project.

### Decision: No Liveness Probe on the Worker

The worker has no HTTP server, so it cannot be probed via `httpGet`. The options were: adding a minimal HTTP server just for the probe; an exec probe, where the worker writes a heartbeat file and the probe checks its mtime; or relying on `restartPolicy: Always`. The third option is chosen for now — if the worker process exits (crash, unhandled rejection), k3s restarts it immediately. The exec probe is documented as a TODO in `worker.yaml` for when silent hangs (channel open but no messages draining) become a concern.
