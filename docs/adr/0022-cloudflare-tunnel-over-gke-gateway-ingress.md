# ADR 0022 — External Access via Cloudflare Tunnel, Not GKE Gateway/Ingress

**Status:** Proposed

**Date:** 2026-07-19

---

## Context

EventHorizon's `server.yaml` currently exposes a `NodePort` Service, explicitly
marked dev-only. Production deployment to GKE needs a real external entry
point for the REST ingestion endpoint, the dashboard, and the WebSocket feed.

Two shapes were considered: a GKE Gateway API (or classic Ingress) resource
provisioning a Google Cloud Application Load Balancer, versus Cloudflare
Tunnel. The GCP-native path costs a real, recurring amount regardless of
traffic — a load balancer forwarding rule runs ~$18.25/month before any data
processing charges, and no GCP free tier applies to it. That's on top of
Rhizome Lens landing in the same cluster later, which would otherwise argue
for a second forwarding rule (or a more complex cross-namespace Gateway
config) to front it too.

EventHorizon is a portfolio deployment meant to stay live continuously, not a
short-lived demo — so "idle but running" cost matters more here than it would
for a workload that's only up during active development. A GCP trial credit
currently covers this cost, but the trial is temporary and the suite has
several more services planned for the same cluster; recurring per-service
network cost compounds in exactly the way this project's own "wait until it
hurts" posture argues against taking on speculatively.

## Decision

Use Cloudflare Tunnel (`cloudflared`) as the external entry point for
EventHorizon, and for Rhizome Lens once it's deployed to the same cluster.

`cloudflared` runs as a normal Deployment in the `event-horizon` namespace,
holding an outbound-only connection to Cloudflare's edge — no Service of type
`LoadBalancer`, no Ingress, no GCP forwarding rule. Cloudflare terminates TLS
and proxies inbound HTTP/WebSocket traffic back through the tunnel to
`event-horizon-server`'s `ClusterIP` Service. Public hostname routing is
configured in Cloudflare, not in Kubernetes manifests.

`server.yaml`'s Service changes from `NodePort` to `ClusterIP`, since it's
now reached only via the tunnel.

When Rhizome Lens is deployed, its dashboard gets a second hostname on the
same tunnel rather than a second ingress path.

## Rationale

Cloudflare Tunnel is free with no published bandwidth cap, supports
WebSocket by default, and eliminates the DNS/certificate provisioning lead
time (30–60 minutes) that a GKE-managed certificate would otherwise require
before the service is reachable. One tunnel can route multiple hostnames to
different in-cluster Services across namespaces, so EventHorizon and Lens
share a single entry point without a second recurring cost.

The tradeoff, named explicitly: this path doesn't exercise GKE's own
Gateway API or Ingress controller, which would otherwise be a legitimate
piece of portfolio evidence for GKE-specific networking experience. That
evidence is deliberately traded for standing cost avoidance on a
continuously-running deployment.

## Alternatives Considered

| Option | Pro | Con |
|---|---|---|
| GKE Gateway API + Application Load Balancer | Native GKE networking; demonstrates Gateway API, HTTPRoute, cross-namespace ReferenceGrant | ~$18.25/month+ recurring, uncovered by any free tier, for as long as the cluster runs; static IP and managed-certificate lead time |
| Classic GCE Ingress | Simpler resource than Gateway API | Same recurring cost as above; Ingress objects only route to Services in their own namespace, so fronting both EventHorizon and Lens needs an ExternalName workaround or a second Ingress entirely |
| Cloudflare Tunnel | $0 recurring cost; WebSocket support by default; one tunnel fronts multiple namespaces; no cert/DNS lead time | Doesn't exercise GKE's own load-balancing surface; routing config lives outside the cluster's own manifests |

## Consequences

- `k3s/server.yaml`'s Service changes from `NodePort` to `ClusterIP`.
- A new `k3s/cloudflared.yaml` manifest is added (Deployment + Secret
  reference for the tunnel token).
- The tunnel token is a real secret — created via `kubectl create secret`
  directly against the cluster, never committed. This matches
  `event-horizon-secrets`'s *imperative provisioning* (create on-cluster,
  never through a committed file), but not its tracked-template half
  (`secret.example.yaml`). That template exists to document a local-dev
  fill-in-and-apply workflow (MONGO/RabbitMQ credentials have a real local
  equivalent to fill in); the tunnel token has no such workflow — it's
  issued once by Cloudflare when the tunnel is created and only makes sense
  in a deployed context, with no companion non-secret fields to split out.
  A tracked example file here would document a shape that doesn't exist.
- Public DNS for EventHorizon (and later Lens) is managed in Cloudflare's
  dashboard, not through a GCP static IP reservation.
- Revisit trigger: if a specific role or interview context calls for
  demonstrated GKE Gateway API experience, or if traffic ever grows past what
  a free Cloudflare Tunnel reasonably covers.