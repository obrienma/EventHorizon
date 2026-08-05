---
id: eventhorizon-2026-07-19T0930-atlas-connectivity
repo: eventhorizon
title: "MongoDB Atlas Connectivity: A Full-Day Elimination Ending in Cloud NAT"
date: 2026-07-19
phase: 29
tags: [mongodb, atlas, gke, tls, cloud-nat, debugging-methodology, kubernetes, autopilot]
files: []
---

### Pattern: Testing Each Hypothesis With a Result That Could Cut Either Way

Every step was structured so its result could fall on either side and mean something either way, rather than seeking confirmation of an existing suspicion. The SNI test is the clearest example: correct SNI, no SNI, and deliberately wrong SNI were all tested against the same host — three configurations that would have produced different results if SNI routing were the actual gate. All three failed identically, which is what made ruling it out conclusive rather than suggestive. The same discipline held across roughly ten hypotheses over the day.

### Anti-Pattern Avoided: Trusting a Client-Side TLS Option That the Driver Silently Ignores

Testing OpenSSL 3.x's legacy-renegotiation default as a candidate cause initially meant passing `secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT` directly as a `MongoClient` option. Before trusting a negative result, the driver's own source (`node_modules/mongodb/lib/cmap/connect.js`) was checked: `secureOptions` isn't in the driver's `LEGAL_TLS_SOCKET_OPTIONS` allowlist, so passing it that way is silently dropped — a false-negative test that would have appeared to rule out a real cause never actually applied. The correct mechanism is a custom `tls.createSecureContext` passed as `secureContext`, which is honored. Re-tested with the correct mechanism, inside the app's real production image, before treating the hypothesis as ruled out.

### Pattern: Reading the Failure's Shape as Evidence, Not Just Its Existence

A candidate cause (MTU/fragmentation, per GKE's own troubleshooting docs describing a near-identical symptom) was reconsidered specifically because of how the failure presented: every reproduction produced a fast, cleanly-parsed TLS alert record (`ssl3_read_bytes:tlsv1 alert internal error`), not a hang or timeout. A genuine MTU/PMTUD black-hole characteristically produces a stall, not a prompt well-formed response. This ran alongside directly measured MTU values (consistent at 1460 at every layer) — the shape-of-failure reasoning and the direct measurement corroborated each other.

### Challenge: Autopilot's Own Security Boundaries Blocked the Most Direct Diagnostic

`kubectl debug node/<node-name>` — the natural way to get a node-level packet capture — is flatly rejected on GKE Autopilot (`hostNetwork/hostPID/hostPath are not allowed`). A hard platform boundary, not a permissions gap. Worked around with a regular pod carrying `NET_ADMIN`/`NET_RAW` running `tcpdump` on its own interface instead — narrower visibility, but the closest available diagnostic without leaving Autopilot's boundaries.

### Decision: A Temporary GKE Standard Cluster as a Throwaway Diagnostic Tool

Autopilot offers no way to give a pod or node a direct external IP — Standard-only. A small, temporary GKE Standard cluster was stood up purely to test one thing: same app image, same driver, same Atlas cluster, node given a direct external IP, Cloud NAT structurally absent from the path. It connected on the first attempt. This was the single test that converted "Cloud NAT is one of several remaining suspects" into a confirmed structural cause. Deleted immediately after — it existed only to answer one question.

### Pattern: Checking Public IP-Reputation Databases as Corroborating, Not Conclusive, Evidence

When an AWS-adjacent reputation-flagging theory was live (Atlas's shared-tier proxy runs on AWS EC2), AbuseIPDB was checked directly: zero reports, 0% confidence, not even in the database. Treated as real evidence against that specific theory, but not proof of a negative — a private classification system wouldn't show up in any public database regardless of whether it exists. The theory was weakened by this check, not closed by it; a subsequent GCP-hosted Atlas cluster and the direct-external-IP test are what actually closed it.

### Challenge: A Second, Independently-Provisioned Atlas Cluster Failing Identically Ruled Out an Entire Class of Explanation at Once

A working theory held that one specific Atlas cluster's underlying shared-tier host might be in a bad state, citing replica-set elections and host restarts visible in Atlas's own Activity Feed. A second, entirely fresh Atlas cluster — new cluster, new database user, same project — failed identically, closing the cluster-specific theory outright rather than just weakening it. The same pattern repeated with a third cluster hosted on GCP instead of AWS, additionally closing every AWS-specific theory at once, since that cluster never touches AWS at all.
