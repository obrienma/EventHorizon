import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),

  // MongoDB
  MONGO_URI: z.string().url(),
  MONGO_DB_NAME: z.string().min(1),

  // RabbitMQ
  RABBITMQ_URL: z.string().min(1),

  // Queue / Exchange names
  EXCHANGE_NAME: z.string().min(1),
  QUEUE_NAME: z.string().min(1),
  DEAD_LETTER_QUEUE: z.string().min(1),
  WORKER_PREFETCH: z.coerce.number().int().min(1).default(5),

  // Backpressure thresholds
  QUEUE_DEPTH_WARNING: z.coerce.number().int().min(1).default(50),
  QUEUE_DEPTH_CRITICAL: z.coerce.number().int().min(1).default(200),

  // Observability
  STATS_PUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),
  METRICS_RATE_WINDOW_MS: z.coerce.number().int().min(100).default(10000),
  EVENT_DISTRIBUTION_POLL_MS: z.coerce.number().int().min(100).default(10000),
});

const result = ConfigSchema.safeParse(process.env);

if (!result.success) {
  console.error("❌ Invalid environment configuration:");
  for (const issue of result.error.issues){
    console.error(` ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = result.data;
export type Config = typeof result.data;
