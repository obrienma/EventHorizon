import type { AppEvent } from "../ingestion/event.schema.js";

// ── EnrichedMeta ──────────────────────────────────────────────────────────────
// Pure enrichment — no I/O, no side effects. Testable without mocks.
// receivedAt: when the worker dequeued the message (wall clock at consume time)
// enrichedAt: when enrichment completed (captures processing latency)

export interface EnrichedMeta {
  receivedAt: Date;
  enrichedAt: Date;
}

// Design Decision — two timestamps instead of one:
// receivedAt - enrichedAt delta surfaces enrichment processing time in metrics.
// If this grows beyond a few milliseconds, it signals a hot processor.

export function enrich(_event: AppEvent, receivedAt: Date = new Date()): EnrichedMeta {
  return {
    receivedAt,
    enrichedAt: new Date(),
  };
}
