---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-26, mongodb, kubernetes, secrets]
---
Q: `config.ts`'s Zod schema makes `MONGO_URI`, `MONGO_HOST`, `MONGO_USERNAME`, and `MONGO_PASSWORD` all individually `.optional()`, then adds a `.refine()`. Why not just make `MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD` required now that Atlas is the deployment target?

A: Two supported shapes need to coexist: local docker-compose (a single unauthenticated `MONGO_URI`, e.g. `mongodb://localhost:27017`) and Atlas (three discrete credential fields, so `MONGO_PASSWORD` can live in a k8s Secret separately from the non-secret `MONGO_HOST`/`MONGO_USERNAME` in the ConfigMap). Making the discrete fields required would break local dev; making `MONGO_URI` required again would reintroduce the original problem of one opaque string with no clean secret/non-secret split. The `.refine()` enforces "one full shape or the other" at parse time instead of picking a single required shape.

Extra: EventHorizon · Phase 26 · Decision: Discrete Credential Fields Instead of a Single Opaque MONGO_URI Secret
See: docs/journal.md#phase-26-mongodb-atlas-config--rabbitmq-credential-split-adr-0021

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-26, typescript, zod]
---
After `ConfigSchema`'s `.refine()` guarantees that either `MONGO_URI` or all three of `MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD` are present, TypeScript still can't see across the refine to narrow the optional fields — so the tempting shortcut was {{c1::`env.MONGO_USERNAME!`/`env.MONGO_PASSWORD!` non-null assertions}}. Instead, `config.ts` re-checks all three with a plain `&&` guard and falls through to {{c2::an explicit `if (!mongoUri) { ...; process.exit(1); }`}} — unreachable in practice, but it satisfies strict null checks honestly instead of asserting past them.

Extra: EventHorizon · Phase 26 · Anti-Pattern Avoided: `!` Non-Null Assertions to Paper Over a Runtime Guarantee
See: docs/journal.md#phase-26-mongodb-atlas-config--rabbitmq-credential-split-adr-0021

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-26, security, secrets]
---
Q: A `sed` filter redacting `.env` output on lines matching `PASSWORD|SECRET|KEY` in the variable name still let a real password reach the conversation transcript in full. Why did the filter miss it, and what's the actual lesson (not "write a better regex")?

A: The real password was embedded inline inside the `MONGO_URI` value (`mongodb+srv://user:password@host`) — the *variable name* on that line was `MONGO_URI`, which doesn't match `PASSWORD|SECRET|KEY`, even though the *value* contained a password. Any regex keyed on variable names is one embedded-credential pattern away from missing something. The actual fix isn't a smarter pattern — it's not `cat`-ing a secrets file into a shared context at all when the same information could come from a targeted read of a known line, or from asking the user directly.

Extra: EventHorizon · Phase 26 · Challenge: A Redaction Filter Missed an Embedded Secret
See: docs/journal.md#phase-26-mongodb-atlas-config--rabbitmq-credential-split-adr-0021

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-26, rabbitmq, kubernetes]
---
Q: Why does RabbitMQ's default `guest`/`guest` credential pair work fine for EventHorizon's local docker-compose setup but silently reject every connection once RabbitMQ runs in-cluster on GKE?

A: RabbitMQ hardcodes a localhost-only connection restriction on the literal username `guest` — for every protocol including AMQP — regardless of what password it's given. In docker-compose, the app process runs on the host and reaches RabbitMQ through a published Docker port, which presents to RabbitMQ as a loopback connection, so the restriction never triggers. In the GKE deployment, `server`/`worker` are separate pods reaching the `rabbitmq` Service over the pod network, which is not loopback — so `guest`/`guest` fails with `user 'guest' can only connect via localhost`. The fix is a dedicated non-`guest` username/password pair, which RabbitMQ's own docs recommend over disabling the loopback check.

Extra: EventHorizon · Phase 26 · Anti-Pattern Avoided: RabbitMQ's Hardcoded guest Loopback Restriction
See: docs/journal.md#phase-26-mongodb-atlas-config--rabbitmq-credential-split-adr-0021

---
type: cloze
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-26, rabbitmq, secrets]
---
The first fix for RabbitMQ's `guest` restriction stored `RABBITMQ_USER`/`RABBITMQ_PASSWORD` *and* fully pre-built `RABBITMQ_URL`/`RABBITMQ_MANAGEMENT_URL` strings in `secret.yaml` — {{c1::four fields encoding two real values}}, kept in sync only by a comment. The fix applied the same pattern `config.ts` already used for `MONGO_URI`: added `RABBITMQ_HOST`/`RABBITMQ_USER`/`RABBITMQ_PASSWORD` as optional fields and {{c2::derived RABBITMQ_URL/RABBITMQ_MANAGEMENT_URL from them at parse time}}, so `secret.yaml` only needs the one credential pair.

Extra: EventHorizon · Phase 26 · Decision: Derive RabbitMQ's URLs the Same Way MongoDB's Is Derived
See: docs/journal.md#phase-26-mongodb-atlas-config--rabbitmq-credential-split-adr-0021

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-26, git, secrets]
---
Q: `k3s/secret.yaml` was gitignored and renamed to a tracked `secret.example.yaml` template specifically to stop real credentials from being committed. What new risk did that same gitignoring introduce, and how was it caught?

A: A gitignored file produces no diff for `git status`/`git diff` to surface — so when manual edits to the local `secret.yaml` reverted its `MONGO_*` fields back to a plain `MONGO_URI` (out of sync with `secret.example.yaml`'s discrete `MONGO_HOST`/`MONGO_USERNAME`/`MONGO_PASSWORD` shape), nothing in the normal git workflow would have flagged it. Gitignoring a secrets file removes the commit-time safety net but also removes the diff-time visibility net that would normally catch this kind of drift. It was only caught by explicitly cross-checking `secret.yaml`'s and `secret.example.yaml`'s key sets against each other — the substitute check needed whenever a file is gitignored specifically because it holds real values.

Extra: EventHorizon · Phase 26 · Challenge: Manual Edits Diverged the Local Secret From Its Own Template
See: docs/journal.md#phase-26-mongodb-atlas-config--rabbitmq-credential-split-adr-0021

---
type: basic
deck: Rhizome::EventHorizon
tags: [eventhorizon, phase-26, testing, dotenv]
---
Q: A script simulating Kubernetes' `envFrom` merge (ConfigMap + Secret) kept resolving `RABBITMQ_URL` to the real local `guest`/`guest`/`localhost` value, even though neither the simulated ConfigMap nor Secret defined `RABBITMQ_URL` at all. What caused this, and how was the simulation fixed?

A: `config.ts`'s `import "dotenv/config"` reads `.env` from `process.cwd()` and silently back-fills any environment variable not already present in `process.env`. The simulation script never explicitly set `RABBITMQ_URL` (it was deliberately omitted, to test the derivation path), so dotenv filled it in from the real project `.env` — masking whether the derivation logic was actually running. Fixed by `process.chdir()`-ing into a directory with no `.env` file before importing `config.js`, so dotenv had nothing to back-fill and the simulated env vars were the only source.

Extra: EventHorizon · Phase 26 · Challenge: dotenv/config's Silent Env-Var Backfill Contaminated a Verification Script
See: docs/journal.md#phase-26-mongodb-atlas-config--rabbitmq-credential-split-adr-0021
