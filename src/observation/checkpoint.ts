import type { ResumeToken } from "mongodb";
import { getDb } from "../storage/db.js";

// ── Pattern: Durable Checkpoint ───────────────────────────────────────────────
// Persists the change stream's resume token to MongoDB so pod restarts (k3s
// evictions, rolling deploys, OOM kills) don't lose the cursor position.
//
// Single document keyed by DOC_ID. updateOne with upsert:true on every
// delivered event — fast, idempotent, no race condition on concurrent writes
// (there is only one change stream consumer per server process).
//
// Failure mode — oplog overrun:
// If the server is down long enough for the oplog to roll past the saved
// token, MongoDB rejects it with error 286 (ChangeStreamHistoryLost).
// changeStream.ts detects that code and calls clearResumeToken() before
// retrying without a token, accepting the gap in delivery.

export const CHECKPOINT_COLLECTION = "changestream_checkpoints";
const DOC_ID = "observation";

interface CheckpointDoc {
  _id: string;
  token: unknown;
  updatedAt: Date;
}

function col() {
  return getDb().collection<CheckpointDoc>(CHECKPOINT_COLLECTION);
}

export async function loadResumeToken(): Promise<ResumeToken | null> {
  const doc = await col().findOne({ _id: DOC_ID });
  if (!doc) return null;
  return doc.token as ResumeToken;
}

export async function saveResumeToken(token: ResumeToken): Promise<void> {
  await col().updateOne(
    { _id: DOC_ID },
    { $set: { token, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function clearResumeToken(): Promise<void> {
  await col().deleteOne({ _id: DOC_ID });
}
