---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-28, ci-cd, github-actions]
---
The GitHub Actions workflow's `on: push: branches: [{{c1::main}}]` trigger never matched anything because this repo's actual default branch is {{c2::master}} — producing {{c3::no error, no failed run, no warning}} anywhere in the Actions tab, just an empty run history.

Extra: EventHorizon · Phase 28 · Challenge: A Silent Branch-Trigger Mismatch Stopped the Image Pipeline Before It Ever Ran
See: docs/journal/eventhorizon-2026-07-19T0915-gke-first-deployment.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-28, kubernetes, rabbitmq, probes]
---
Q: RabbitMQ crash-looped on first GKE deploy. What did `kubectl describe pod`'s Events section reveal was actually happening, and why was the root cause CPU starvation rather than memory pressure?

A: The Events section showed `Liveness probe failed: command timed out: "rabbitmq-diagnostics ping" timed out after 10s`. That diagnostic command spins up a short-lived Erlang node, competing for real CPU with the broker under the original 256m CPU limit — kubelet was correctly killing a pod whose probe failed, but the broker itself was never actually unhealthy. Fixed by raising CPU request/limit (100m/256m → 250m/500m) and loosening the probe timeout (10s → 20s).

Extra: EventHorizon · Phase 28 · Challenge: RabbitMQ's Liveness Probe Timing Out Under a Too-Tight CPU Limit, Not an OOM Kill
See: docs/journal/eventhorizon-2026-07-19T0915-gke-first-deployment.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-28, kubernetes, debugging]
---
A crashed pod's `--previous` logs showing a clean {{c1::"SIGTERM received - shutting down"}} with normal teardown (not an abrupt log-free cutoff) points at {{c2::kubelet reacting to a failed liveness probe}} rather than {{c3::an OOM kill}}, which produces no graceful shutdown log at all.

Extra: EventHorizon · Phase 28 · Pattern: Reading the Shutdown Sequence to Distinguish a Probe-Triggered SIGTERM From an OOM SIGKILL
See: docs/journal/eventhorizon-2026-07-19T0915-gke-first-deployment.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-28, build, typescript]
---
Q: The compiled server crash-looped with `Error: ENOENT ... dist/dashboard/index.html` the first time it ran standalone in GKE, despite working fine in local dev. What was the actual gap, and why had it stayed invisible until now?

A: `"build": "tsc -p tsconfig.build.json"` only compiles `.ts` files — it never copies `src/dashboard/index.html`/`favicon.ico`, which `app.ts` reads via `readFileSync` at module load. Local dev runs against `src/` directly (tsx), never the compiled `dist/` output, so the gap had existed the whole time without being exercised. Fixed by extending the build script to copy both static files into `dist/dashboard/` after `tsc` runs.

Extra: EventHorizon · Phase 28 · Challenge: tsc-Only Build Script Silently Dropped Static Assets the Compiled Server Needed at Startup
See: docs/journal/eventhorizon-2026-07-19T0915-gke-first-deployment.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-28, adr, networking, cost]
---
ADR 0022 chose {{c1::Cloudflare Tunnel}} over a {{c2::GKE Gateway API}}-provisioned load balancer for external access, explicitly trading away legitimate portfolio evidence of using GKE's own Gateway API in exchange for avoiding a recurring cost of roughly {{c3::$18.25/month}} on a deployment meant to stay live continuously.

Extra: EventHorizon · Phase 28 · Decision: Cloudflare Tunnel Over GKE Gateway API for External Access (ADR 0022)
See: docs/journal/eventhorizon-2026-07-19T0915-gke-first-deployment.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-28, adr, secrets]
---
ADR 0022's first draft claimed the Cloudflare tunnel token's provisioning matched the `event-horizon-secrets` pattern outright; on review this was corrected because it only matches the {{c1::imperative half}} (create on-cluster, never commit) — not the {{c2::tracked-template half}} (`secret.example.yaml`'s fill-in-and-apply workflow) — since the tunnel token is {{c3::issued once by Cloudflare with no local-dev equivalent}}.

Extra: EventHorizon · Phase 28 · Anti-Pattern Avoided: Overclaiming a Match to the Existing Secrets Pattern
See: docs/journal/eventhorizon-2026-07-19T0915-gke-first-deployment.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-28, kubernetes, configmap]
---
After editing `configmap.yaml` and running `kubectl apply`, already crash-looping pods showed no change, because a running pod only reads `envFrom` {{c1::once, at startup}} — a ConfigMap/Secret change requires {{c2::`kubectl rollout restart`}} on the affected Deployment to actually take effect.

Extra: EventHorizon · Phase 28 · Challenge: A Configuration Change Doesn't Reach Already-Running Pods
See: docs/journal/eventhorizon-2026-07-19T0915-gke-first-deployment.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-28, kubernetes, secrets, rabbitmq]
---
Q: Why would recreating `event-horizon-secrets` with `kubectl delete secret` + `kubectl create secret` using only the new `MONGO_PASSWORD` key have broken RabbitMQ, even though RabbitMQ was already running fine on the old secret?

A: `rabbitmq.yaml` reads `RABBITMQ_USER`/`RABBITMQ_PASSWORD` via `secretKeyRef` to bootstrap its own admin account. A running pod keeps whatever values it already injected, so nothing would break immediately — but its *next* restart would read a Secret no longer holding those keys and fail to authenticate. Fixed by always resupplying every key the Secret currently holds, not just the one being changed.

Extra: EventHorizon · Phase 28 · Challenge: Recreating a Secret Without Every Key It Currently Holds Breaks an Unrelated Consumer on Its Next Restart
See: docs/journal/eventhorizon-2026-07-19T0915-gke-first-deployment.md
