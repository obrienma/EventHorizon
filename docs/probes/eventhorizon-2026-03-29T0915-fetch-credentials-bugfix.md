---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, nodejs, fetch, http]
---
Node's native `fetch()` throws `{{c1::Request cannot be constructed from a URL that includes credentials}}` for a URL like `http://guest:guest@localhost:15672`, because the Fetch spec forbids `user:pass@host` credentials — they leak into logs, Referer headers, and browser history. The correct mechanism is an `{{c2::Authorization}}` header.

Extra: EventHorizon · Phase 8 · Challenge: Node.js Native fetch Rejects Credentials Embedded in URLs
See: docs/journal/eventhorizon-2026-03-29T0915-fetch-credentials-bugfix.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, nodejs, fetch, debugging]
---
Before the fix, `fetch()` threw on every call but the metrics interval {{c1::silently swallowed the error}}, returning `{{c2::queueDepth: 0}}` every tick — a masked failure that looked like an empty queue rather than a broken request.

Extra: EventHorizon · Phase 8 · Challenge: Node.js Native fetch Rejects Credentials Embedded in URLs
See: docs/journal/eventhorizon-2026-03-29T0915-fetch-credentials-bugfix.md

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-8, http, anti-pattern]
---
The fix strips `username`/`password` off the URL via `{{c1::new URL()}}` and instead sends `{{c2::Authorization: Basic <base64 of user:pass>}}` as a header — curl/axios tolerate credentials-in-URL, but Node 18+ native fetch and browser fetch both reject it per spec.

Extra: EventHorizon · Phase 8 · Anti-Pattern Avoided: Credentials in URLs
See: docs/journal/eventhorizon-2026-03-29T0915-fetch-credentials-bugfix.md
