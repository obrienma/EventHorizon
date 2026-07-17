import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z
  .object({
    // Server
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    HOST: z.string().default("0.0.0.0"),

    // MongoDB — either a full connection string (local docker-compose, no auth)
    // or discrete Atlas credentials. Kept separate so MONGO_PASSWORD can live in
    // a k8s Secret while MONGO_HOST/MONGO_USERNAME stay in the ConfigMap with
    // everything else non-secret. Note: don't validate MONGO_URI as a url —
    // e.g. "mongodb://localhost:27017" isn't one.
    MONGO_URI: z.string().min(1).optional(),
    MONGO_HOST: z.string().min(1).optional(),
    MONGO_USERNAME: z.string().min(1).optional(),
    MONGO_PASSWORD: z.string().min(1).optional(),
    MONGO_DB_NAME: z.string().min(1),

    // RabbitMQ — same either/or shape as MongoDB above: a full URL (local
    // docker-compose, guest/guest) or discrete cluster credentials, so
    // RABBITMQ_PASSWORD can live in a k8s Secret without also duplicating it
    // into two pre-built URL strings that could drift out of sync.
    RABBITMQ_URL: z.string().min(1).optional(),
    RABBITMQ_MANAGEMENT_URL: z.url().optional(),
    RABBITMQ_HOST: z.string().min(1).optional(),
    RABBITMQ_USER: z.string().min(1).optional(),
    RABBITMQ_PASSWORD: z.string().min(1).optional(),

    // Queue / Exchange names
    EXCHANGE_NAME: z.string().min(1),
    QUEUE_NAME: z.string().min(1),
    DEAD_LETTER_QUEUE: z.string().min(1),
    WORKER_PREFETCH: z.coerce.number().int().min(1).default(5),

    // Backpressure thresholds
    QUEUE_DEPTH_WARNING: z.coerce.number().int().min(1).default(50),
    QUEUE_DEPTH_CRITICAL: z.coerce.number().int().min(1).default(200),

    // WebSocket backpressure thresholds (bytes of socket.bufferedAmount) — see ADR 0018
    WS_BUFFERED_AMOUNT_SKIP: z.coerce.number().int().min(1).default(1_000_000),
    WS_BUFFERED_AMOUNT_TERMINATE: z.coerce.number().int().min(1).default(5_000_000),

    // Observability
    STATS_PUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
    METRICS_RATE_WINDOW_MS: z.coerce.number().int().min(100).default(10_000),
    EVENT_DISTRIBUTION_POLL_MS: z.coerce.number().int().min(100).default(10_000),

    // Fault injection (dashboard/demo use only — 0 disables)
    CHAOS_ERROR_RATE: z.coerce.number().min(0).max(1).default(0),
  })
  .refine((env) => env.MONGO_URI ?? (env.MONGO_HOST && env.MONGO_USERNAME && env.MONGO_PASSWORD), {
    message: "Set MONGO_URI, or all of MONGO_HOST + MONGO_USERNAME + MONGO_PASSWORD",
    path: ["MONGO_URI"],
  })
  .refine((env) => env.RABBITMQ_URL ?? (env.RABBITMQ_HOST && env.RABBITMQ_USER && env.RABBITMQ_PASSWORD), {
    message: "Set RABBITMQ_URL, or all of RABBITMQ_HOST + RABBITMQ_USER + RABBITMQ_PASSWORD",
    path: ["RABBITMQ_URL"],
  });

const result = ConfigSchema.safeParse(process.env);
if (!result.success) {
  console.error("❌ Invalid environment configuration:");
  for (const issue of result.error.issues) {
    console.error(` ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = result.data;

// Resolve to a single connection string: an explicit MONGO_URI wins (local
// docker-compose, unauthenticated); otherwise build the Atlas SRV URI from
// discrete credentials. The .refine() above guarantees one of these two
// branches has everything it needs — no `!` assertions required.
const mongoUri =
  env.MONGO_URI ??
  (env.MONGO_HOST && env.MONGO_USERNAME && env.MONGO_PASSWORD
    ? `mongodb+srv://${encodeURIComponent(env.MONGO_USERNAME)}:${encodeURIComponent(env.MONGO_PASSWORD)}@${env.MONGO_HOST}/?retryWrites=true&w=majority`
    : undefined);

if (!mongoUri) {
  // Unreachable given the .refine() above — satisfies strict null checks.
  console.error("❌ Invalid environment configuration: could not resolve a MongoDB connection string");
  process.exit(1);
}

// Same derivation shape as MongoDB: an explicit RABBITMQ_URL wins; otherwise
// build it from discrete cluster credentials. RABBITMQ_MANAGEMENT_URL falls
// back further, to the guest/guest local-dev default, since it's optional
// even in cluster mode (only used to poll queue depth for the dashboard).
const rabbitmqUrl =
  env.RABBITMQ_URL ??
  (env.RABBITMQ_HOST && env.RABBITMQ_USER && env.RABBITMQ_PASSWORD
    ? `amqp://${encodeURIComponent(env.RABBITMQ_USER)}:${encodeURIComponent(env.RABBITMQ_PASSWORD)}@${env.RABBITMQ_HOST}:5672`
    : undefined);

if (!rabbitmqUrl) {
  // Unreachable given the .refine() above — satisfies strict null checks.
  console.error("❌ Invalid environment configuration: could not resolve a RabbitMQ connection string");
  process.exit(1);
}

const rabbitmqManagementUrl =
  env.RABBITMQ_MANAGEMENT_URL ??
  (env.RABBITMQ_HOST && env.RABBITMQ_USER && env.RABBITMQ_PASSWORD
    ? `http://${encodeURIComponent(env.RABBITMQ_USER)}:${encodeURIComponent(env.RABBITMQ_PASSWORD)}@${env.RABBITMQ_HOST}:15672`
    : "http://guest:guest@localhost:15672");

export const config = {
  ...env,
  MONGO_URI: mongoUri,
  RABBITMQ_URL: rabbitmqUrl,
  RABBITMQ_MANAGEMENT_URL: rabbitmqManagementUrl,
};
export type Config = typeof config;
