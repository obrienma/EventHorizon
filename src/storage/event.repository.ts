import { MongoServerError } from "mongodb";
import { getDb } from "./db.js";
import type { AppEvent, ProcessedMeta, StoredEvent } from "../ingestion/event.schema.js";

// ── Collection name ───────────────────────────────────────────────────────────

export const EVENTS_COLLECTION = "events";

// ── Pattern: Idempotent Receiver ─────────────────────────────────────────────
// At-least-once delivery means the worker may receive the same message twice
// (e.g., ack lost before broker received it → redelivery). The unique index
// { "raw.id": 1 } on the events collection absorbs duplicate inserts silently.
//
// Hard Invariant (from CLAUDE.md): documents are NEVER updated after insert.
// "processed" sub-document is written once on first successful processing.
// This is append-only storage — no update, no upsert, no replace.
//
// Design Decision — only swallow code 11000 (duplicate key):
// If we caught all MongoServerError types, genuine write failures (auth errors,
// disk full, network drop) would be silently ignored and the message would be
// acked — permanently lost. We only ignore the one error that represents a
// known-safe idempotent re-insert.

export async function saveEvent(
  raw: AppEvent,
  processed: ProcessedMeta,
): Promise<void> {
  const doc = {
    raw,
    status: "processed" as const,
    processed,
  };

  try {
    await getDb().collection(EVENTS_COLLECTION).insertOne(doc);
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      // Duplicate key — this message was already processed on a prior delivery.
      // Silently ignore: idempotent insert, not an error.
      return;
    }
    // All other errors re-throw — the worker's catch block will retry/dead-letter.
    throw err;
  }
}

export async function saveFailedEvent(raw: AppEvent): Promise<void> {
  const doc = {
    raw,
    status: "failed" as const,
  };

  try {
    await getDb().collection(EVENTS_COLLECTION).insertOne(doc);
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      return;
    }
    throw err;
  }
}

// ── ensureIndexes ─────────────────────────────────────────────────────────────
// Called once at startup. createIndex is idempotent — safe to call every time.
// The unique index is what makes the Idempotent Receiver pattern work.

export async function ensureIndexes(): Promise<void> {
  await getDb()
    .collection(EVENTS_COLLECTION)
    .createIndex({ "raw.id": 1 }, { unique: true, name: "unique_event_id" });

  console.log("[repository] indexes ensured");
}
