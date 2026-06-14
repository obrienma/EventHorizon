---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, nodejs, fetch]
---
Node's native `fetch()` throws `{{c1::Request cannot be constructed from a URL that includes credentials}}` when given a URL containing `user:pass@host` — the Fetch spec forbids embedded credentials because they leak into {{c2::logs, Referer headers, and browser history}}.

Extra: EventHorizon · Phase 8 · Challenge: Node.js Native fetch Rejects Credentials Embedded in URLs
See: docs/journal.md#phase-8-bug-fix-credentials-in-fetch-urls

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, nodejs, fetch]
---
The fix for embedded URL credentials is to parse with `{{c1::new URL()}}`, extract `username`/`password`, strip them from the request URL, and pass `{{c2::Authorization: Basic <base64>}}` as a header instead.

Extra: EventHorizon · Phase 8 · Anti-Pattern Avoided: Credentials in URLs
See: docs/journal.md#phase-8-bug-fix-credentials-in-fetch-urls

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, debugging, observability]
---
Q: The metrics interval was silently returning `queueDepth: 0` every tick instead of throwing visibly. What was the actual root cause, and why did the failure mode make it hard to spot?

A: `RABBITMQ_MANAGEMENT_URL=http://guest:guest@localhost:15672` was passed directly to `fetch()`, which threw because the Fetch spec forbids credentials embedded in URLs. The metrics interval caught and swallowed that error, defaulting `queueDepth` to 0 — so the dashboard kept rendering a plausible-looking value (zero queue depth) instead of an error, masking the failure as "everything's fine, the queue is just empty."

Extra: EventHorizon · Phase 8 · Challenge: Node.js Native fetch Rejects Credentials Embedded in URLs
See: docs/journal.md#phase-8-bug-fix-credentials-in-fetch-urls
