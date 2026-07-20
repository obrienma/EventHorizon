# ADR 0023 — In-Cluster MongoDB, Reversing ADR 0021

**Status:** Accepted

**Date:** 2026-07-19

**Supersedes:** ADR 0021 ("MongoDB Atlas Over In-Cluster MongoDB")

---

## Context

ADR 0021 chose MongoDB Atlas over in-cluster MongoDB for the GKE deployment, reasoning that Atlas's managed replica set avoided reintroducing the host-stability operational burden that change streams (ADR 0008) impose on a self-managed replica set. That reasoning was sound at the time and isn't being reversed because it was wrong — it's being reversed because Atlas connectivity from this specific deployment turned out not to work, for reasons unrelated to anything ADR 0021 anticipated.

A full day of methodical investigation, using three independent Atlas clusters across two cloud providers, established the following with direct, reproducible evidence:

- Every connection attempt from GKE pods to Atlas fails identically with `SSL routines:ssl3_read_bytes:tlsv1 alert internal error` (SSL alert 80), immediately after `ClientHello`, regardless of which Atlas cluster is targeted.
- Ruled out with direct testing: Atlas IP allowlist (confirmed Active on the correct project), SNI-based tenant routing (correct/none/wrong SNI all fail identically), TLS protocol version (1.2 and 1.3 fail identically), OpenSSL legacy renegotiation (tested via the driver's real `secureContext` option inside the app's production image), cluster-specific proxy state (three separate clusters, including one hosted on GCP itself, all fail identically), public IP reputation (the egress IP shows zero abuse reports and 0% confidence score on AbuseIPDB), and MTU/fragmentation (measured values are consistent end-to-end at every layer, and a bare Compute Engine VM on the identical VPC/subnet/MTU connects successfully).
- Confirmed as the mechanism: **Cloud NAT itself.** A temporary GKE Standard cluster with nodes given direct external IPs — structurally removing Cloud NAT from the path entirely, with no other change — connected successfully on the first attempt, using the same app image, driver version, and Atlas cluster that had failed 100% of the time through NAT.
- Private connectivity (VPC Peering, Private Service Connect, PrivateLink) was evaluated as a way to avoid the public-internet-plus-NAT path entirely, but Atlas restricts all of these to M10+ dedicated clusters — unavailable on the M0 free tier at any configuration, and would mean leaving the free tier for infrastructure this project has otherwise kept free-tier-first throughout.

The practical result: GKE Autopilot offers no supported way to give pods or nodes a direct external IP — that capability is Standard-only, and was only usable here as a temporary diagnostic cluster, not a production option without reversing ADR 0020's Autopilot choice as well.

## Decision

**In-cluster MongoDB, not Atlas, for EventHorizon's GKE deployment.** A new `k3s/mongodb.yaml` manifest adds a single-replica Deployment + PVC + ClusterIP Service, mirroring `docker-compose.yml`'s existing local configuration exactly: `mongo:7`, run as a single-node replica set (`--replSet rs0 --bind_ip_all`), unauthenticated.

No code changes are needed. `config.ts`'s schema, built in ADR 0021 to support either a full `MONGO_URI` or three discrete credential fields, already supports the unauthenticated-`MONGO_URI` shape — it's the exact shape local dev has used from the start. Only `k3s/configmap.yaml` changes: `MONGO_URI` is set directly (non-secret, since there's no password in an unauthenticated connection) to `mongodb://mongodb.event-horizon.svc.cluster.local:27017/eventhorizon?replicaSet=rs0`, and the now-unused `MONGO_HOST`/`MONGO_USERNAME` placeholders are removed. `k3s/secret.yaml`'s `MONGO_PASSWORD` field is removed entirely — there is no longer a Mongo secret to manage.

## Rationale

**This sidesteps the problem rather than solving it, deliberately.** Today's investigation confirmed *that* Cloud NAT breaks this connection, not precisely *why* — the exact mechanism inside Cloud NAT remains unknown. Betting on a specific fix for an unconfirmed mechanism (e.g., assuming it's fixable via some NAT setting never tried) would be weaker engineering than removing the dependency on Cloud NAT entirely. Pod-to-pod traffic within the same cluster never touches Cloud NAT, regardless of what's actually happening there.

**Reuses a pattern already proven today, not a new one.** `k3s/rabbitmq.yaml` (ADR 0020) already established the single-replica Deployment + PVC + ClusterIP Service shape for a stateful in-cluster service, including the `Recreate` rollout strategy needed for a `ReadWriteOnce` PVC. `mongodb.yaml` follows that same shape exactly.

**Free, not a bet against the project's own free-tier-first posture.** The alternative that most directly addresses the *actual* mechanism — Atlas private connectivity — requires M10+ (~$57+/month), which this project has avoided everywhere else (Neon, Upstash, Cloudflare R2, GKE Autopilot itself). Reversing that posture to solve one connectivity problem, without even a confirmed guarantee it fixes it, is a worse trade than a well-understood free alternative.

**Authentication deliberately deferred, matching this project's established posture.** MongoDB runs unauthenticated here, exactly matching `docker-compose.yml`'s local configuration and matching ADR 0020's own reasoning for RabbitMQ's non-credentialed pattern at demo scale (there, `guest`/`guest`; here, no auth at all, since MongoDB has no equivalent hardcoded-localhost restriction forcing the question). This is safe specifically because the Service is `ClusterIP`, reachable only from inside the cluster's own pod network — never exposed through the Cloudflare Tunnel (ADR 0022) or any external path. Revisit trigger: if this cluster ever holds real (non-demo) data, or if a second tenant/service ever needs scoped access to this specific database.

**Single-node replica set, not a true multi-node one.** Change streams (ADR 0008) require a replica set's oplog — a standalone `mongod` has none. A single-node replica set satisfies that requirement identically to how Atlas's replica set did, without needing multiple members, `keyFile` inter-member authentication, or the host-stability operational burden ADR 0021 originally wanted to avoid — that concern was specifically about *multi-node* replica set membership stability, which a single node never faces.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| GKE Standard cluster with direct external IPs (bypass Cloud NAT structurally, keep Atlas) | Confirmed to work; keeps MongoDB fully managed | Reverses ADR 0020's Autopilot choice; Standard bills per-VM continuously rather than per-pod-request, a real ongoing cost increase for a mostly-idle deployment; doesn't explain *why* NAT breaks this, just avoids it a different way |
| Atlas Private Service Connect / VPC Peering | Solves the actual mechanism directly (avoids public internet + NAT) if that is in fact the cause | Requires M10+ (~$57+/month minimum); doesn't even guarantee a fix, since the exact NAT mechanism was never isolated beyond "removing NAT entirely resolves it" |
| Continue investigating Cloud NAT's specific behavior (packet capture, NAT allocation logs, etc.) | Might yield a genuine fix that keeps Atlas and Autopilot both | Already a full day invested with no mechanism found beyond "NAT is involved"; diminishing returns against a free, working alternative that's ready now |
| In-cluster MongoDB (this decision) | Free; reuses today's proven RabbitMQ pattern; sidesteps Cloud NAT entirely regardless of its exact behavior; no code changes | Loses Atlas's managed backups/monitoring; reintroduces *some* self-management, though single-node avoids the specific multi-node concern ADR 0021 raised |

## Consequences

- `k3s/mongodb.yaml` is added: single-replica Deployment (`mongo:7`, `--replSet rs0 --bind_ip_all`), PVC, ClusterIP Service — mirrors `k3s/rabbitmq.yaml`'s established shape and `Recreate` rollout strategy.
- `k3s/configmap.yaml`: `MONGO_HOST`/`MONGO_USERNAME` removed; `MONGO_URI` added directly (non-secret) pointing at the in-cluster Service DNS name.
- `k3s/secret.yaml` and `k3s/secret.example.yaml`: `MONGO_PASSWORD` removed — no Mongo secret exists anymore.
- No changes to `src/config.ts` or `src/storage/db.ts` — the unauthenticated-`MONGO_URI` code path already existed for local dev.
- The Atlas clusters created during today's investigation (the original AWS cluster, the second AWS cluster, and the GCP `us-central1` cluster) are no longer needed and can be deleted.
- ADR 0021 remains Accepted as a historical record of a reasonable decision under the information available at the time; it should get a short addendum noting it's superseded by this ADR, per this project's convention of never editing accepted ADR text.
- Change streams (ADR 0008) continue to work unmodified — a single-node replica set's oplog satisfies the same requirement Atlas's replica set did.
- Revisit trigger for authentication: real (non-demo) data in this database, or a second service needing scoped access.
- No `kubectl` available in this environment — `k3s/mongodb.yaml` and the updated `configmap.yaml`/`secret.yaml` files are validated as syntactically-correct YAML only, not dry-run/schema-validated against a live API server; that verification is still outstanding, same gap noted in ADR 0020.
