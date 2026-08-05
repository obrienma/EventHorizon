---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-25, kubernetes, rabbitmq]
---
Q: `k3s/rabbitmq.yaml` sets `strategy.type: Recreate` on the RabbitMQ Deployment instead of leaving the Kubernetes default. Why would the default have been a problem here specifically?

A: The default Deployment strategy is `RollingUpdate`, which starts the new pod before terminating the old one so there's no downtime. RabbitMQ's pod mounts a `ReadWriteOnce` PVC (`rabbitmq-data`), and with only one replica, a `ReadWriteOnce` volume can only be mounted by one pod at a time. Under `RollingUpdate`, the new pod would wait to mount the volume the old pod still holds, while the old pod waits to be told it's safe to terminate — a deadlock on every rollout. `Recreate` terminates the old pod first, so the volume is free before the new pod starts.

Extra: EventHorizon · Phase 25 · Anti-Pattern Avoided: RollingUpdate Against a Singly-Mounted PVC
See: docs/journal/eventhorizon-2026-07-14T0900-gke-rabbitmq-manifest.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-25, kubernetes, secrets]
---
In `k3s/rabbitmq.yaml`, `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS` are set as {{c1::plain literal env values}} on the Deployment, not pulled from `event-horizon-secrets` — because guest/guest isn't sensitive and the broker is only reachable in-cluster. But `k3s/secret.yaml`'s `RABBITMQ_URL` still gets {{c2::the real base64-encoded connection string}}, not an empty placeholder, because that's the field `config.ts` actually reads the connection string from — leaving it empty would leave the app unable to connect even though nothing in the value is secret.

Extra: EventHorizon · Phase 25 · Decision: guest/guest Stays a Plain Env Var, Not a Secret, in the Deployment Itself
See: docs/journal/eventhorizon-2026-07-14T0900-gke-rabbitmq-manifest.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-25, adr, gke]
---
Q: ADR 0020 resolves the Helm-vs-raw-manifests and RabbitMQ-placement questions "for EventHorizon specifically." Why not resolve them for Rhizome Lens at the same time, since Xylem-L6's ADR 0003 named both services under one shared pattern?

A: The two services aren't equally close to deployable — EventHorizon already has raw `k3s/*.yaml` manifests written against a local k3s target, while Rhizome Lens has no Kubernetes manifests at all yet (docker-compose only). Deciding Lens's manifest approach now would be speculative, since Lens's own Prometheus/Loki/Tempo/Grafana stack was the specific case Xylem-L6's ADR 0003 made for Helm being a good fit there — a case that stands on Lens's own merits and doesn't need to be settled to unblock EventHorizon today.

Extra: EventHorizon · Phase 25 · Decision: Raw Manifests Stay Raw, RabbitMQ Goes In-Cluster
See: docs/journal/eventhorizon-2026-07-14T0900-gke-rabbitmq-manifest.md
