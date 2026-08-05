---
id: eventhorizon-2026-07-19T0915-gke-first-deployment
repo: eventhorizon
title: "First GKE Deployment: Branch Trigger, Probe Tuning, and a Build Gap"
date: 2026-07-19
phase: 28
tags: [github-actions, kubernetes, gke, rabbitmq, liveness-probes, cloudflare-tunnel, adr, secrets, build]
files: [.github/workflows/build-and-push.yml, k3s/rabbitmq.yaml, package.json, k3s/server.yaml, k3s/cloudflared.yaml, docs/adr/0022-cloudflare-tunnel-over-gke-gateway-ingress.md]
---

### Challenge: A Silent Branch-Trigger Mismatch Stopped the Image Pipeline Before It Ever Ran

`.github/workflows/build-and-push.yml`'s `on: push: branches: [main]` never matched anything, because this repo's actual default branch is `master` — a mismatch that produces no error, no failed run, no warning anywhere in the Actions tab, just an empty run history. Found by checking `git branch -a` against the workflow's trigger line. Fixed by changing the trigger to `branches: [master]`.

### Challenge: RabbitMQ's Liveness Probe Timing Out Under a Too-Tight CPU Limit, Not an OOM Kill

RabbitMQ crash-looped on first deploy. `kubectl describe pod`'s Events section named it directly: `Liveness probe failed: command timed out: "rabbitmq-diagnostics ping" timed out after 10s`. That command spins up a short-lived Erlang node, real CPU work competing with the broker under the original `256m` limit. Kubelet was correctly killing a pod that failed its own health check; the broker was never actually unhealthy. The RabbitMQ probe timeout wasn't memory pressure — it was CPU starvation from a limit set too low for the startup sequence. Fixed by raising CPU request/limit (100m/256m to 250m/500m) and loosening the probe timeout (10s to 20s).

### Pattern: Reading the Shutdown Sequence to Distinguish a Probe-Triggered SIGTERM From an OOM SIGKILL

Before Events confirmed the cause directly, the crashed pod's `--previous` logs showed a clean `SIGTERM received - shutting down` with normal teardown, not the abrupt log-free cutoff an OOM kill produces. A graceful shutdown means something asked the process to stop; in this context that meant kubelet reacting to a failed probe, not the OOM killer.

### Challenge: `tsc`-Only Build Script Silently Dropped Static Assets the Compiled Server Needed at Startup

Server and worker crash-looped with `Error: ENOENT ... dist/dashboard/index.html`. `"build": "tsc -p tsconfig.build.json"` only compiles `.ts` files; it never copies `src/dashboard/index.html`/`favicon.ico`, which `app.ts` reads via `readFileSync` at module load. Invisible in local dev, which runs against `src/` directly rather than the compiled `dist/` output. This was the first time the built artifact ever ran standalone, and it exposed a gap that had existed the whole time. Fixed by extending the build script to copy both files into `dist/dashboard/` after `tsc` runs.

### Decision: Cloudflare Tunnel Over GKE Gateway API for External Access (ADR 0022)

A GKE Gateway API/Ingress-provisioned load balancer costs roughly $18.25/month, uncovered by any free tier, recurring for as long as the cluster runs — real cost on a portfolio deployment meant to stay live continuously. Cloudflare Tunnel was chosen instead: an outbound-only connection to Cloudflare's edge, no forwarding rule, no static IP, WebSocket by default. Named explicitly as a tradeoff: this path doesn't exercise GKE's own Gateway API, which would otherwise be legitimate portfolio evidence — traded deliberately for standing cost avoidance.

### Anti-Pattern Avoided: Overclaiming a Match to the Existing Secrets Pattern

ADR 0022's first draft said the tunnel token's provisioning matched `event-horizon-secrets`'s pattern outright. Caught on review: it matches the imperative half (create on-cluster, never commit) but not the tracked-template half (`secret.example.yaml`'s fill-in-and-apply workflow) — the tunnel token has no local-dev equivalent, since it's issued once by Cloudflare and only makes sense deployed. Corrected the ADR to name precisely which half applies.

### Challenge: A Configuration Change Doesn't Reach Already-Running Pods

After editing `configmap.yaml` and running `kubectl apply`, crash-looping pods showed no change. `kubectl apply` updates the object, but a running pod only reads `envFrom` once, at startup — not hot-reloaded. Any ConfigMap/Secret change needs `kubectl rollout restart` on the affected Deployment to take effect.

### Challenge: Recreating a Secret Without Every Key It Currently Holds Breaks an Unrelated Consumer on Its Next Restart

`event-horizon-secrets` needed a new `MONGO_PASSWORD`. `kubectl delete secret` + `kubectl create secret` with only Mongo keys would have silently dropped `RABBITMQ_USER`/`RABBITMQ_PASSWORD`, which `rabbitmq.yaml` reads via `secretKeyRef` to bootstrap its own admin account. A running RabbitMQ pod keeps its already-injected values, but its next restart would fail to authenticate against a secret missing those keys. Fixed by always resupplying every key the object currently holds, not just the one being changed.
