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

  switch (event.type){
    case "pipeline":
      // TODO: implement this

    case "sensor":
      // TODO: implement this

    case "app":
      return {
        classification: "normal",
        tags: ["app", event.payload.action],
      };

  }
}
