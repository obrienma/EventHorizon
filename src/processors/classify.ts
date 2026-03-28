import type { AppEvent, Classification } from "../ingestion/event.schema.js";

// ── ClassifiedMeta ────────────────────────────────────────────────────────────
// Pure classification — no I/O. Derives severity and searchable tags from the
// event's discriminated union shape.

export interface ClassifiedMeta {
  classification: Classification;
  tags: string[];
}

// Design Decision — classification lives in a processor, not in the schema:
// The event schema (event.schema.ts) describes shape only — it has no opinion
// about business severity. Classification rules change over time; keeping them
// here means we can update them without touching the shared contract.

export function classify(event: AppEvent): ClassifiedMeta {
  switch (event.type) {
    case "pipeline": {
      if (event.payload.status === "failed") {
        return { classification: "critical", tags: ["pipeline", "failed"] };
      }
      if (event.payload.status === "started") {
        return { classification: "normal", tags: ["pipeline", "started"] };
      }
      // "passed"
      return { classification: "normal", tags: ["pipeline", "passed"] };
    }

    case "sensor": {
      // TODO: apply domain-specific thresholds per metric.
      // e.g. temperature > 85°C → "critical", > 70°C → "warning"
      // For now, all sensor readings are "normal" — implement the thresholds here.
      return { classification: "normal", tags: ["sensor", event.payload.metric] };
    }

    case "app": {
      return { classification: "normal", tags: ["app", event.payload.action] };
    }
  }
}
