import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // Minimum env vars required by config.ts Zod schema (no defaults).
      // Real infrastructure is never touched in unit tests — all I/O modules
      // are mocked. These values only satisfy the schema validation at import time.
      MONGO_URI: "mongodb://localhost:27017",
      MONGO_DB_NAME: "test",
      RABBITMQ_URL: "amqp://localhost",
      EXCHANGE_NAME: "events",
      QUEUE_NAME: "events.work",
      DEAD_LETTER_QUEUE: "events.dead",
    },
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/seed/**", "src/dashboard/**"],
    },
  },
});
