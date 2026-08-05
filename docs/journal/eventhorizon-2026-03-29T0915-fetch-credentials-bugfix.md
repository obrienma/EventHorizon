---
id: eventhorizon-2026-03-29T0915-fetch-credentials-bugfix
repo: eventhorizon
title: "Bug Fix: Credentials in fetch URLs"
date: 2026-03-29
phase: 8
tags: [nodejs, fetch, http-basic-auth, url-credentials, rabbitmq-management-api]
files: [src/observation/metrics.ts]
---

### Challenge: Node.js Native `fetch` Rejects Credentials Embedded in URLs

`RABBITMQ_MANAGEMENT_URL=http://guest:guest@localhost:15672` was passed directly to `fetch()`. Node's native fetch (and the browser Fetch API) threw `Request cannot be constructed from a URL that includes credentials`. The metrics interval silently swallowed the error and returned `queueDepth: 0` every tick. Credentials in a URL (`user:pass@host`) are a legacy HTTP basic auth convention that the Fetch spec explicitly forbids, because they leak into logs, `Referer` headers, and browser history — the correct mechanism is the `Authorization` header. The fix parses the URL with `new URL()` to extract `username` and `password`, strips them from the request URL, and passes `Authorization: Basic <base64>` as a header:

```ts
const base = new URL(config.RABBITMQ_MANAGEMENT_URL);
const auth = Buffer.from(`${base.username}:${base.password}`).toString("base64");
const url  = `${base.protocol}//${base.host}/api/...`;
const res  = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
```

### Anti-Pattern Avoided: Credentials in URLs

`http://user:pass@host` works in older HTTP clients (curl, axios) that don't enforce the Fetch spec, so it's easy to carry this habit into Node 18+ native fetch or browser code, where it breaks silently or with a cryptic error. Always use `Authorization` headers for HTTP basic auth.
