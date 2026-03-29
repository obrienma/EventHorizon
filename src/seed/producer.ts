import "dotenv/config";
import { randomUUID } from "crypto";

// ── Pattern: Fixed-Rate Emission ─────────────────────────────────────────────
// setInterval fires a send() every (1000 / rate) ms. Simple and correct for a
// seed tool. A token bucket would smooth micro-bursts more accurately but adds
// complexity with no real benefit here — the server handles bursts fine.
//
// Design Decision — no config.ts import:
// config.ts exits the process if MONGO_URI or RABBITMQ_URL are missing.
// The seed producer only needs the server's HTTP port — importing config.ts
// would require a full .env setup just to run the producer, which defeats the
// purpose of a standalone dev tool.

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);

const RATE = Math.max(1, Number(args["rate"] ?? 1));          // events/sec
const TYPE = (args["type"] ?? "all") as "pipeline" | "sensor" | "app" | "all";
const DURATION_SEC = args["duration"] ? Number(args["duration"]) : null;
const DRY_RUN = args["dry-run"] === "true";
const BASE_URL = args["url"] ?? `http://localhost:${process.env.PORT ?? 3000}`;

const VALID_TYPES = ["pipeline", "sensor", "app", "all"];
if (!VALID_TYPES.includes(TYPE)) {
  console.error(`[seed] invalid --type="${TYPE}". Must be: pipeline | sensor | app | all`);
  process.exit(1);
}

// ── Random event generators ───────────────────────────────────────────────────

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function makePipelineEvent() {
  const status = randomItem(["started", "passed", "failed"] as const);
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: `ci-runner-${Math.floor(Math.random() * 5) + 1}`,
    type: "pipeline" as const,
    payload: {
      pipelineId: `pipe-${Math.floor(Math.random() * 100)}`,
      step: randomItem(["build", "test", "lint", "deploy", "scan"]),
      status,
      // TODO: make durationMs correlate with status — failed runs should have
      // a realistic shorter duration than passed ones.
      ...(status !== "started" && { durationMs: Math.floor(Math.random() * 60_000) }),
    },
  };
}

function makeSensorEvent() {
  const metric = randomItem(["temperature", "humidity", "pressure"] as const);

  // TODO: add per-metric realistic value ranges (e.g. temperature: -10–50°C,
  // humidity: 0–100%, pressure: 900–1100 hPa). Currently uses a flat range
  // so classify.ts will rarely trigger warning/critical thresholds.
  const valueByMetric: Record<typeof metric, { value: () => number; unit: string }> = {
    temperature: { value: () => Math.round((Math.random() * 80 - 10) * 10) / 10, unit: "°C" },
    humidity:    { value: () => Math.round(Math.random() * 100 * 10) / 10,        unit: "%" },
    pressure:    { value: () => Math.round((900 + Math.random() * 200) * 10) / 10, unit: "hPa" },
  };

  const { value, unit } = valueByMetric[metric];
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: `sensor-${Math.floor(Math.random() * 20) + 1}`,
    type: "sensor" as const,
    payload: { sensorId: `s-${Math.floor(Math.random() * 50)}`, metric, value: value(), unit },
  };
}

function makeAppEvent() {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    source: randomItem(["web", "mobile-ios", "mobile-android", "api"]),
    type: "app" as const,
    payload: {
      action: randomItem(["login", "logout", "page_view", "purchase", "search", "error"]),
      userId: Math.random() > 0.2 ? `user-${Math.floor(Math.random() * 1000)}` : undefined,
    },
  };
}

function makeEvent() {
  const pick = TYPE === "all" ? randomItem(["pipeline", "sensor", "app"] as const) : TYPE;
  if (pick === "pipeline") return makePipelineEvent();
  if (pick === "sensor") return makeSensorEvent();
  return makeAppEvent();
}

// ── Send ──────────────────────────────────────────────────────────────────────

let sent = 0;
let failed = 0;

async function send(): Promise<void> {
  const event = makeEvent();

  if (DRY_RUN) {
    console.log("[seed] dry-run:", JSON.stringify(event));
    sent++;
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });

    if (res.ok) {
      sent++;
      console.log(`[seed] sent ${event.type} event (id: ${event.id}) → ${res.status}`);
    } else {
      failed++;
      const body = await res.text();
      console.error(`[seed] rejected ${event.type} event → ${res.status}: ${body}`);
    }
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED")) {
      console.error(`[seed] server not reachable at ${BASE_URL} — is it running?`);
    } else {
      console.error(`[seed] send error:`, message);
    }
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

function printSummary(): void {
  console.log(`\n[seed] done — sent: ${sent}, failed: ${failed}`);
}

console.log(
  `[seed] starting — rate: ${RATE}/s, type: ${TYPE}${DURATION_SEC ? `, duration: ${DURATION_SEC}s` : ""}${DRY_RUN ? ", dry-run" : ""}`,
);

const interval = setInterval(() => { void send(); }, Math.floor(1000 / RATE));

if (DURATION_SEC !== null) {
  setTimeout(() => {
    clearInterval(interval);
    printSummary();
    process.exit(0);
  }, DURATION_SEC * 1000);
}

process.on("SIGINT", () => {
  clearInterval(interval);
  printSummary();
  process.exit(0);
});
