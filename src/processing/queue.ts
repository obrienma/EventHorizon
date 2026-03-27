import type { AppEvent } from "../ingestion/event.schema.js";

// ── publishEvent ──────────────────────────────────────────────────────────────
// Routing key convention: events.<type> — matches the work queue binding events.#
// TODO [step 3]: replace stub with real AMQP channel publish

export async function publishEvent(_event: AppEvent): Promise<void> {
  // stub — real implementation wires in the AMQP channel
}
