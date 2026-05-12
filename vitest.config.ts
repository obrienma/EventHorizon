import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      MONGO_URI: "mongodb://localhost:27017/?directConnection=true",
      MONGO_DB_NAME: "eventhorizon_test",
      RABBITMQ_URL: "amqp://guest:guest@localhost:5672",
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
