---
id: eventhorizon-2026-06-03T0915-dockerfile
repo: eventhorizon
title: "Dockerfile"
date: 2026-06-03
phase: 12
tags: [docker, multi-stage-build, non-root-user, tsconfig, k3s]
files: [Dockerfile, .dockerignore, tsconfig.build.json, package.json]
---

### Pattern: Multi-Stage Docker Build

A single stage that compiles TypeScript would carry devDependencies (`tsx`, `typescript`, `vitest`, `mongodb-memory-server`) into the production image, bloating it by 4–5×. The builder stage installs all dependencies and compiles to `dist/`; the runner stage starts fresh from the same base image, runs `npm ci --omit=dev` (production deps only), and copies only `dist/` from the builder. The final image contains no TypeScript toolchain — only the compiled JS and its runtime dependencies.

### Anti-Pattern Avoided: Running as Root in a Container

Docker containers run as root by default. In Kubernetes/k3s, many cluster security policies (PodSecurityAdmission, OPA Gatekeeper) reject pods that run as root, and even without policy enforcement, a root process that escapes the container namespace has full host access. The fix: `RUN addgroup -S app && adduser -S app -G app` in the runner stage creates a system user, and `USER app` before `CMD` drops privileges. The `-S` flag creates a system account with no password and no home directory entry in `/etc/passwd`'s login shell.

### Decision: Single Image, Two Entry Points

Server and worker share the entire codebase — same `src/`, same `tsconfig`, same `package.json`. Two Dockerfiles would duplicate the build steps and risk drifting out of sync. One image, two entry points: the server Deployment uses the default `CMD ["node", "dist/server.js"]`; the worker Deployment overrides it with `command: ["node", "dist/processing/worker.js"]` in the k3s manifest. Same image tag, different process, no duplication.

### Decision: `tsconfig.build.json` for Production Compilation

`tsconfig.json` includes `src/**/*`, which covers `*.test.ts` files. Compiling them into `dist/` is harmless — they're never executed in production — but adds noise and `vitest`/`mongodb-memory-server` imports to the image. `tsconfig.build.json` extends the base and adds `"exclude": ["src/**/*.test.ts"]`, keeping `dist/` clean. The `typecheck` script still uses the root tsconfig so tests remain type-checked in CI.

### Challenge: Stale `dist/` From Incremental `tsc`

`tsc` does not delete previously compiled files that are no longer in the compilation scope. Adding `tsconfig.build.json` to exclude test files only prevented new compilations — old `*.test.js` files from previous runs remained in `dist/`. The fix is `rm -rf dist/` before compilation: `"build": "rm -rf dist/ && tsc -p tsconfig.build.json"`. Without the clean step, the first build after adding the exclude would appear to work but silently include stale test artifacts.

### Challenge: `dotenv` No-Op in Production

`import "dotenv/config"` in `config.ts` is a no-op when no `.env` file exists (dotenv silently ignores missing files). k3s injects env vars from ConfigMap/Secret references before the process starts, so `process.env` is already populated. Zod validation then runs against the injected values. Tested: running the worker image without any env vars produces the correct Zod error and exits 1 — the config boundary is working correctly.
