---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-29, debugging, methodology]
---
Q: What made the SNI test during the Atlas connectivity investigation a *conclusive* rule-out rather than merely suggestive?

A: It was structured so the result could cut either way: correct SNI, no SNI, and deliberately wrong SNI were all tested against the same host. If SNI routing were the actual gate, these three configurations would have produced different results. All three failed identically, which is what made ruling SNI out conclusive — the same discipline (designing each test so it could fail in either direction) was applied across roughly ten hypotheses that day.

Extra: EventHorizon · Phase 29 · Pattern: Testing Each Hypothesis With a Result That Could Cut Either Way
See: docs/journal/eventhorizon-2026-07-19T0930-atlas-connectivity.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-29, mongodb, tls, driver-internals]
---
Testing OpenSSL 3.x's legacy-renegotiation default as a candidate cause by passing `secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT` directly as a `MongoClient` option would have been a false-negative test, because the MongoDB Node driver's {{c1::`LEGAL_TLS_SOCKET_OPTIONS`}} allowlist silently drops it; the mechanism the driver actually honors is a custom {{c2::`tls.createSecureContext`}} passed as {{c3::`secureContext`}}.

Extra: EventHorizon · Phase 29 · Anti-Pattern Avoided: Trusting a Client-Side TLS Option That the Driver Silently Ignores
See: docs/journal/eventhorizon-2026-07-19T0930-atlas-connectivity.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-29, networking, tls, mtu]
---
Q: MTU/fragmentation was a candidate cause (per GKE's own troubleshooting docs describing a near-identical symptom). Why was it reconsidered based on the *shape* of the failure rather than just the measured MTU values?

A: A genuine MTU/PMTUD black-hole characteristically produces a stall or timeout, not a clean response — but every reproduction of this failure produced a fast, cleanly-parsed TLS alert record (`ssl3_read_bytes:tlsv1 alert internal error`) immediately after ClientHello. That failure shape argued against MTU/fragmentation independently of the directly-measured MTU values (consistent at 1460 at every layer), and the two lines of evidence corroborated each other.

Extra: EventHorizon · Phase 29 · Pattern: Reading the Failure's Shape as Evidence, Not Just Its Existence
See: docs/journal/eventhorizon-2026-07-19T0930-atlas-connectivity.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-29, gke, kubernetes, autopilot]
---
`kubectl debug node/<node-name>` — the natural way to get a node-level packet capture — is flatly rejected on GKE Autopilot because {{c1::hostNetwork/hostPID/hostPath are not allowed}}, a hard platform boundary rather than a permissions gap; the workaround was a regular pod carrying {{c2::NET_ADMIN/NET_RAW}} capabilities running `tcpdump` on its own interface instead.

Extra: EventHorizon · Phase 29 · Challenge: Autopilot's Own Security Boundaries Blocked the Most Direct Diagnostic
See: docs/journal/eventhorizon-2026-07-19T0930-atlas-connectivity.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-29, gke, decision, diagnostics]
---
Q: Why was a temporary GKE *Standard* cluster stood up specifically to test Atlas connectivity, and what single fact did it establish?

A: GKE Autopilot offers no way to give a pod or node a direct external IP — only Standard supports that. The temporary Standard cluster ran the same app image, same driver, against the same Atlas cluster, but with a node given a direct external IP, structurally removing Cloud NAT from the path. It connected on the first attempt, converting "Cloud NAT is one of several remaining suspects" into a confirmed structural cause. It was deleted immediately after — it existed only to answer that one question.

Extra: EventHorizon · Phase 29 · Decision: A Temporary GKE Standard Cluster as a Throwaway Diagnostic Tool
See: docs/journal/eventhorizon-2026-07-19T0930-atlas-connectivity.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-29, networking, evidence]
---
When an AWS-adjacent IP-reputation theory was live, AbuseIPDB showed zero reports and 0% confidence — treated as evidence {{c1::against}} that theory, but not proof of a negative, since {{c2::a private classification system}} wouldn't show up in any public database regardless of whether it exists; the theory was only actually closed by {{c3::a GCP-hosted Atlas cluster and the direct-external-IP test}}.

Extra: EventHorizon · Phase 29 · Pattern: Checking Public IP-Reputation Databases as Corroborating, Not Conclusive, Evidence
See: docs/journal/eventhorizon-2026-07-19T0930-atlas-connectivity.md

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-29, mongodb, atlas, debugging]
---
Q: A working theory held that one specific Atlas cluster's underlying shared-tier host might be in a bad state. How was this theory closed, and how did a third cluster extend the rule-out further?

A: A second, entirely fresh Atlas cluster (new cluster, new database user, same project) failed identically, closing the cluster-specific-bad-host theory outright rather than just weakening it. A third cluster, hosted on GCP instead of AWS, additionally closed every AWS-specific theory at once, since that cluster never touches AWS infrastructure at all.

Extra: EventHorizon · Phase 29 · Challenge: A Second, Independently-Provisioned Atlas Cluster Failing Identically Ruled Out an Entire Class of Explanation at Once
See: docs/journal/eventhorizon-2026-07-19T0930-atlas-connectivity.md
