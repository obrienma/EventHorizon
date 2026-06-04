# ── Stage 1: Build ────────────────────────────────────────────────────────────
# Compile TypeScript to dist/. Uses devDependencies (tsc), which are NOT
# carried into the production stage.
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production runtime ───────────────────────────────────────────────
# Fresh node_modules without devDependencies (~4–5× smaller).
# Non-root user — required by most k3s/Kubernetes security policies.
FROM node:24-alpine AS runner
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

USER app

# PORT is read from the environment; this is documentation only.
EXPOSE 3000

# Default: HTTP server + WebSocket + change stream observer.
# Worker Deployment in k3s overrides this:
#   spec.containers[].command: ["node", "dist/processing/worker.js"]
CMD ["node", "dist/server.js"]
