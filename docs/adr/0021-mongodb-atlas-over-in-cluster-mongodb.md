# ADR 0021 — MongoDB Atlas Over In-Cluster MongoDB

**Status:** Rejected

**Date:** 2026-07-14

**Superseded by:** [ADR 0023](./0023-in-cluster-mongodb-reversing-adr-0021.md) (2026-07-19) — Atlas connectivity from GKE pods failed 100% of the time via Cloud NAT (SSL alert 80 on every attempt), confirmed by a working connection once Cloud NAT was structurally removed from the path. The decision below remains an accurate record of the reasoning at the time; it wasn't wrong given the information available, it was overtaken by an environment-specific connectivity failure this ADR had no way to anticipate. See ADR 0023 for the investigation and the reversal.

---

## Context

ADR 0020 resolved RabbitMQ's placement for the GKE deployment (in-cluster) but left MongoDB's placement implicit — the existing `k3s/` manifests never included a MongoDB Deployment/StatefulSet at all, and `docker-compose.yml`'s single-node replica set (`--replSet rs0`) was assumed to be a local-only convenience, not a deployment target.

That assumption is now moot: the user has provisioned a MongoDB Atlas cluster (`rhizome-risk.buqccap.mongodb.net`) and wants EventHorizon to connect to it instead of standing up MongoDB in-cluster. This needed a code change, not just a manifest: `config.ts` previously required a single `MONGO_URI` string, which worked for the unauthenticated local replica set but has nowhere natural to keep a real Atlas password out of version control — the URI format embeds it directly (`mongodb+srv://user:password@host`).

## Decision

**MongoDB Atlas, not in-cluster MongoDB, for the GKE deployment.** `config.ts` now accepts either a full `MONGO_URI` (local docker-compose, unauthenticated) or three discrete values — `MONGO_HOST`, `MONGO_USERNAME`, `MONGO_PASSWORD` — from which it builds the `mongodb+srv://` connection string itself. This mirrors the split ADR 0020 already established for RabbitMQ: non-secret values (`MONGO_HOST`, `MONGO_USERNAME`) live in `k3s/configmap.yaml`, the real secret (`MONGO_PASSWORD`) lives in `k3s/secret.yaml`.

No `k3s/mongodb.yaml` is written — unlike RabbitMQ, there's no existing manifest assuming an in-cluster DNS name to fulfill, and Atlas is now the actual target.

## Rationale

**Atlas over in-cluster MongoDB, symmetric-looking but not the same choice as ADR 0020's RabbitMQ decision.** ADR 0020 chose in-cluster RabbitMQ because the existing manifests already assumed a cluster-local DNS name — the path of least resistance was to fulfill that assumption, not relitigate it. No such assumption exists for MongoDB; nothing in `k3s/` ever named an in-cluster Mongo service. With a green field and Atlas already provisioned, using it directly avoids reintroducing MongoDB's most operationally demanding property in this stack — a replica set (required for change streams, per ADR 0008) needs the same host-stability care that already caused a recurring local dev snag (Phase 23's stale-hostname replica-set reconfig, docs/journal.md). Atlas manages replica set membership itself; a PVC-backed in-cluster StatefulSet would reintroduce that exact class of problem in production, not just in local dev.

**Discrete credential fields over a single `MONGO_URI` secret.** The RabbitMQ precedent (ADR 0020) could hardcode `guest`/`guest` directly into the Deployment because those aren't real credentials. Atlas credentials are real, so the same shortcut isn't available — but collapsing everything into one opaque `MONGO_URI` secret value, as the original schema did, forces the *entire* string to be secret even though the host and username aren't sensitive on their own. Splitting into `MONGO_HOST`/`MONGO_USERNAME` (ConfigMap) + `MONGO_PASSWORD` (Secret) keeps only the actually-sensitive value in the Secret, and keeps the host/username visible for debugging (`kubectl describe configmap`) without needing secret access.

**`.refine()` over two parallel required-field sets.** `config.ts`'s schema makes `MONGO_URI`, `MONGO_HOST`, `MONGO_USERNAME`, and `MONGO_PASSWORD` all individually optional, with a `.refine()` enforcing "MONGO_URI, or all three of the others" at parse time. This keeps local dev (docker-compose, no auth) and Atlas (credentialed) as two supported shapes of the same config, rather than forcing local dev to fake credentials or forcing a breaking change on every existing `.env`.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| In-cluster MongoDB (StatefulSet + PVC, mirroring the `rabbitmq.yaml` pattern) | Consistent with ADR 0020's RabbitMQ placement; no external dependency | Reintroduces replica-set host-stability operations (already a felt local dev pain point, Phase 23) in production; Atlas already exists and solves this |
| Single `MONGO_URI` secret with the full Atlas connection string | Minimal schema change; matches the original local-dev shape exactly | Forces the entire string (including non-sensitive host/username) into the Secret; no way to inspect host/username without secret access |
| Keep `MONGO_URI` required, drop discrete-credential support | Simplest schema | Doesn't solve the actual problem — the password still ends up embedded in a single opaque value with no clean k8s Secret/ConfigMap split |

## Consequences

- `src/config.ts`: `MONGO_URI` is now optional; `MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD` are new optional fields; a `.refine()` requires one complete shape or the other. The exported `config.MONGO_URI` is always a resolved, ready-to-use string regardless of which shape was supplied — `src/storage/db.ts` needed no changes.
- `.env.example` documents both shapes; `.env` (gitignored) uses the Atlas shape.
- `k3s/configmap.yaml` gains `MONGO_HOST`/`MONGO_USERNAME` as placeholder values (`your-cluster.mongodb.net` / `your-db-user`) — not real values, per the same "don't commit real credentials" posture `secret.yaml` already states.
- `k3s/secret.yaml`'s `MONGO_URI` field is replaced with `MONGO_PASSWORD`, left as an empty placeholder like `MONGO_URI` was.
- No `k3s/mongodb.yaml` manifest exists or is planned — MongoDB is Atlas-hosted, out of cluster scope entirely.
- Atlas's own replica set already satisfies ADR 0008's change-stream requirement (oplog-backed), so `observation/changeStream.ts` needs no changes for this move.
