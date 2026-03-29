import type { ChangeStream } from "mongodb";
import { getDb } from "../storage/db.js";
import { EVENTS_COLLECTION } from "../storage/event.repository.js";
import type { StoredEvent } from "../ingestion/event.schema.js";

// ── Pattern: Event-Driven Push ────────────────────────────────────────────────
// Instead of clients polling MongoDB on an interval ("are there new events?"),
// the change stream inverts control: MongoDB pushes each insert to us the moment
// it is committed to the oplog. We then fan-out to connected WebSocket clients.
//
// Anti-Pattern Avoided: Polling
// A 1-second poll on a collection with 1,000 inserts/sec would return up to
// 1,000 documents per query, most of which clients have already seen. The change
// stream delivers exactly one notification per insert with zero redundant reads.
//
// Design Decision — filter on operationType "insert" in the pipeline:
// Our storage invariant is append-only — updates/deletes never happen. The filter
// is still explicit because it limits oplog entries the driver must inspect, and
// documents the intent for future maintainers.
//
// Design Decision — directConnection=true in MONGO_URI:
// MongoDB change streams require a replica set (they're built on the oplog).
// directConnection=true tells the driver to connect to the specified node directly
// without performing replica set topology discovery. This avoids hostname
// resolution issues when the container's RS member hostname differs from
// "localhost" — a common docker-compose gotcha.

let stream: ChangeStream<StoredEvent> | null = null;

// ── startChangeStream ─────────────────────────────────────────────────────────
// Opens a change stream on the events collection and calls onInsert for every
// new document. Returns a teardown function for graceful shutdown.

export function startChangeStream(
  onInsert: (event: StoredEvent) => void,
): () => Promise<void> {
  stream = getDb()
    .collection<StoredEvent>(EVENTS_COLLECTION)
    .watch<StoredEvent>([{ $match: { operationType: "insert" } }]);

  stream.on("change", (change) => {
    // operationType guard is redundant given the pipeline filter above,
    // but satisfies the TypeScript discriminated union on ChangeStreamDocument.
    if (change.operationType === "insert" && change.fullDocument) {
      onInsert(change.fullDocument);
    }
  });

  stream.on("error", (err: Error) => {
    // Don't attempt recovery here — log and let the process manager restart.
    // A crashed change stream that silently resumes could miss events between
    // the crash and reconnect without a persisted resume token.
    console.error("[changeStream] fatal error:", err.message);
  });

  console.log(`[changeStream] watching "${EVENTS_COLLECTION}" for inserts`);

  return async () => {
    if (stream && !stream.closed) {
      await stream.close();
    }
    console.log("[changeStream] shut down cleanly");
  };
}
