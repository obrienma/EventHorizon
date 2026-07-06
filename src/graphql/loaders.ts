import DataLoader from "dataloader";
import { getDb } from "../storage/db.js";
import { EVENTS_COLLECTION } from "../storage/event.repository.js";
import type { StoredEvent } from "../ingestion/event.schema.js";

export interface GraphQLContext {
  pipelineStepsLoader: DataLoader<string, StoredEvent[]>;
}

// ── Pattern: Batch N pipelineId lookups into one $in query ───────────────────
// Naive resolution of PipelineRun.steps (one find() per pipelineId) is N+1 for
// N runs in a single request. DataLoader collects every .load(id) call made
// during one tick of the event loop, then invokes this batch function once
// with all requested ids — a single $in query regardless of N.
//
// Anti-Pattern Avoided: Mismatched Batch-Result Order
// DataLoader requires the returned array to be the same length and order as
// the `pipelineIds` argument — index i of the result must answer index i of
// the request. Grouping into a Map first and mapping back over `pipelineIds`
// (rather than returning `docs` grouped in whatever order Mongo returned them)
// is what guarantees that.

export function createPipelineStepsLoader(): DataLoader<string, StoredEvent[]> {
  return new DataLoader<string, StoredEvent[]>(async (pipelineIds) => {
    const docs = await getDb()
      .collection<StoredEvent>(EVENTS_COLLECTION)
      .find({ "raw.type": "pipeline", "raw.payload.pipelineId": { $in: [...pipelineIds] } })
      .toArray();

    const byPipelineId = new Map<string, StoredEvent[]>();
    for (const doc of docs) {
      if (doc.raw.type !== "pipeline") continue; // query already guarantees this; narrows for TS
      const steps = byPipelineId.get(doc.raw.payload.pipelineId) ?? [];
      steps.push(doc);
      byPipelineId.set(doc.raw.payload.pipelineId, steps);
    }

    return pipelineIds.map((id) => byPipelineId.get(id) ?? []);
  });
}
