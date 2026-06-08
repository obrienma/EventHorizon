# Getting Started (Local Development)

## Prerequisites

- Node.js 20+
- Docker + Docker Compose
- Git

## 1. Clone and Install

```bash
git clone git@github.com:obrienma/EventHorizon.git
cd EventHorizon
npm install
```

## 2. Environment

```bash
cp .env.example .env
```

The defaults in `.env.example` work with the Docker Compose setup — no changes needed for local development.

## 3. Start Infrastructure

```bash
npm run infra
```

This starts:
- **MongoDB 7** on `localhost:27017`
- **RabbitMQ 3** on `localhost:5672`
- **RabbitMQ Management UI** on `http://localhost:15672` (login: `guest` / `guest`)

Wait ~10s for RabbitMQ to be ready before starting the app.

**Verify:**
```bash
docker compose ps
# Both services should show "healthy" or "running"
```

## 4. Start the Server

```bash
npm run dev
```

The server declares the RabbitMQ topology and MongoDB indexes on first boot — both operations are idempotent.

```
EventHorizon server running on http://localhost:3000
RabbitMQ connected — exchange: events, queue: events.work
MongoDB connected — db: eventhorizon
Change stream watching events collection
```

## 5. Start the Worker (separate terminal)

```bash
npm run worker
```

The worker connects to RabbitMQ and begins consuming from `events.work`. You can run multiple worker processes — RabbitMQ round-robins messages between consumers automatically.

## 6. Generate Fake Events

```bash
# 2 events/second, all types, run indefinitely
npm run seed -- --rate=2 --type=all

# Pipeline events only, for 60 seconds
npm run seed -- --rate=5 --type=pipeline --duration=60

# Preview event shapes without sending
npm run seed -- --dry-run
```

## 7. Open the Dashboard

```
http://localhost:3000/dashboard
```

You should see events flowing in real time within a few seconds of starting the seed producer. The stats bar updates every 5 seconds. Click any event in the feed to inspect its full payload and metadata in the detail panel.

---

## Viewing Distributed Traces

EventHorizon emits OpenTelemetry traces from both `npm run dev` and `npm run worker` (see `src/observation/tracing.ts` and ADR 0015). To see them, you need an OTel Collector + Tempo + Grafana stack reachable at the OTLP/HTTP endpoint configured in `.env` (`OTEL_EXPORTER_OTLP_ENDPOINT`, defaults to `http://localhost:4318`).

That stack is **not part of this repo** — it's a shared local backend (see `.observability/OBSERVABILITY_MIGRATION_PLAN.md` Phase 0 for the docker-compose setup and architecture). Start it before starting EventHorizon. The OTel SDK fails silently if the collector is unreachable: no error, just no trace data — so if Tempo shows nothing, check the collector is up and the endpoint matches before suspecting the app.

Once the collector stack is running:

1. Send an event — `npm run seed -- --rate=1 --duration=5` or `POST /events` directly.
2. Open Grafana on the collector stack (default `http://localhost:3000` — note this collides with the EventHorizon dashboard's default port; run one on a different port if you need both at once).
3. **Explore** → **Tempo** datasource → search by service name `event-horizon` (worker spans report under the same service name).
4. A single trace should span all four pipeline stages as one connected waterfall: HTTP ingest → AMQP publish → `event.process` (worker, continues the trace across the RabbitMQ boundary) → MongoDB insert → `event.observe` (change-stream fanout to WebSocket clients).

For the full manual verification checklist — confirming trace continuity, span attributes, and parse-failure span events — see "Manual Verification: Distributed Tracing" in `docs/TESTING.md`. Tracing isn't covered by the automated suite: `@opentelemetry/api` falls back to a `NoopTracerProvider` under Vitest, so the SDK never initializes and there's nothing to assert against.

---

## Observing Backpressure

To see backpressure in action:

1. Stop the worker (`Ctrl+C`)
2. Run the seed producer at a high rate: `npm run seed -- --rate=20`
3. Watch the RabbitMQ Management UI — messages pile up in `events.work`
4. The dashboard stats bar shows `queueDepth` increasing (turns yellow at 50, red at 200)
5. Restart the worker — it drains the queue; depth returns to 0

## Viewing Dead-Lettered Messages

Messages that fail processing 3 times end up in `events.dead`.

In the RabbitMQ Management UI:
1. Go to **Queues** → `events.dead`
2. Click **Get Messages** to inspect failures

## Running Tests

```bash
# Run once
npm test

# Watch mode
npm run test:watch
```

Tests use `mongodb-memory-server` — no running MongoDB required.

## Type Checking

```bash
npm run typecheck
```

## Stopping Infrastructure

```bash
npm run infra:down
```

Data is persisted in a Docker volume (`mongo_data`). To fully reset:

```bash
docker compose down -v
```

---

## Deployment

### Build the Docker Image

Both the server and worker use the same image. The default `CMD` runs the server; the worker overrides it at the container level.

```bash
npm run build           # compile TypeScript to dist/ (excludes test files)
docker build -t event-horizon:latest .
```

---

### Option A — Local k3s with k3d

**k3d** runs k3s inside Docker containers — no systemd, works on WSL2.

#### 1. Install k3d

```bash
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
```

Or via a package manager: `brew install k3d` / `choco install k3d`.

#### 2. Create a cluster

```bash
k3d cluster create eventhorizon --port "30080:30080@loadbalancer"
```

The `--port` flag forwards NodePort 30080 (used by `k3s/server.yaml`) to `localhost:30080`.

#### 3. Import the image

k3d clusters don't pull from your local Docker daemon by default. Import the image directly:

```bash
k3d image import event-horizon:latest -c eventhorizon
```

Update `k3s/server.yaml` and `k3s/worker.yaml` to use `imagePullPolicy: Never` so k3s uses the imported image rather than trying to pull from a registry.

#### 4. Provision MongoDB and RabbitMQ

The manifests assume MongoDB and RabbitMQ are reachable from inside the cluster. The simplest option for local k3d is to keep using the Docker Compose services and expose them to the cluster via host networking. Add these env overrides to `k3s/configmap.yaml`:

```yaml
MONGO_URI: "mongodb://host.k3d.internal:27017"
RABBITMQ_URL: "amqp://guest:guest@host.k3d.internal:5672"
RABBITMQ_MANAGEMENT_URL: "http://guest:guest@host.k3d.internal:15672"
```

`host.k3d.internal` is the DNS name k3d provides for the host machine.

#### 5. Fill in the Secret

Base64-encode your connection strings and update `k3s/secret.yaml`:

```bash
echo -n "mongodb://host.k3d.internal:27017" | base64
echo -n "amqp://guest:guest@host.k3d.internal:5672" | base64
```

Paste the output into the `MONGO_URI` and `RABBITMQ_URL` fields in `k3s/secret.yaml`.

#### 6. Apply the manifests

```bash
kubectl apply -f k3s/namespace.yaml
kubectl apply -f k3s/configmap.yaml
kubectl apply -f k3s/secret.yaml
kubectl apply -f k3s/server.yaml
kubectl apply -f k3s/worker.yaml
```

#### 7. Verify

```bash
kubectl get pods -n event-horizon
# NAME                                    READY   STATUS    RESTARTS
# event-horizon-server-...                1/1     Running   0
# event-horizon-worker-...  (×2)          1/1     Running   0

curl http://localhost:30080/healthz
# {"status":"ok","mongo":"ok"}
```

Dashboard: `http://localhost:30080/dashboard`

#### Teardown

```bash
k3d cluster delete eventhorizon
```

---

### Option B — Railway

Railway is a PaaS — it runs containers directly, not Kubernetes. The `k3s/` manifests do not apply. Use Railway's service model instead.

#### Prerequisites

- [Railway CLI](https://docs.railway.app/develop/cli): `npm install -g @railway/cli`
- `railway login`

#### 1. Create a project

```bash
railway init
```

#### 2. Provision dependencies

In the Railway dashboard, add two plugins to your project:
- **MongoDB** — Railway provisions a managed instance and injects `MONGO_URL` automatically
- **RabbitMQ** — injects `RABBITMQ_URL` automatically

Note: Railway's injected variable names may differ from what `config.ts` expects (`MONGO_URI` vs `MONGO_URL`). Set the correct names as Railway environment variables in the dashboard.

#### 3. Deploy the server

Railway detects the `Dockerfile` automatically.

```bash
railway up
```

Set these environment variables in the Railway dashboard (Settings → Variables):

```
MONGO_DB_NAME=event-horizon
EXCHANGE_NAME=events
QUEUE_NAME=events.work
DEAD_LETTER_QUEUE=events.dead
WORKER_PREFETCH=5
QUEUE_DEPTH_WARNING=50
QUEUE_DEPTH_CRITICAL=200
STATS_PUSH_INTERVAL_MS=5000
METRICS_RATE_WINDOW_MS=10000
EVENT_DISTRIBUTION_POLL_MS=10000
```

Railway exposes the service on a generated HTTPS domain automatically.

#### 4. Deploy the worker as a separate service

In the Railway dashboard, add a second service from the same repo. In its settings, override the start command:

```
node dist/processing/worker.js
```

The worker shares the same environment variables as the server service.

#### 5. Verify

```bash
curl https://<your-railway-domain>/healthz
# {"status":"ok","mongo":"ok"}
```
