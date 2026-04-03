import type { ChangeStream, ResumeToken } from "mongodb";
import { getDb } from "../storage/db.js";
import { EVENTS_COLLECTION } from "../storage/event.repository.js";
import type { StoredEvent } from "../ingestion/event.schema.js";

// ── Pattern: Change Stream Recovery with Resume Token ─────────────────────────
// MongoDB change streams expose a resume token (change._id) on every event.
// It encodes the cursor's position in the replica set oplog. When a cursor
// dies (MongoDB restart, replica set election, network blip), we reopen the
// stream with { resumeAfter: lastResumeToken }. MongoDB replays any inserts
// that arrived between the crash and the reconnect — zero gap delivery.
//
// Anti-Pattern Avoided: Silent Cursor Death
// The original handler only logged on error. A dead cursor means the change
// stream stops delivering events while metrics continue to work (they issue
// fresh countDocuments queries). The dashboard looks healthy (stats update)
// but the event feed freezes — a deceptive failure mode that went undetected
// for thousands of events.
//
// Design Decision — exponential backoff on retry:
// If MongoDB is down, a tight retry loop generates log spam and wastes CPU.
// Backoff starts at 1s and doubles each attempt, capped at 30s. A successful
// event delivery resets the backoff so a brief blip doesn't permanently slow
// recovery.
//
// Design Decision — in-memory resume token only (not persisted):
// Persisting the token to disk would survive a full server restart. That adds
// file I/O and a startup read path. For this pipeline the observation plane is
// best-effort — a server restart replays nothing, but never hangs. Persistence
// would be the next step in a production system.
//
// Known limitation — oplog overrun:
// If the server is down long enough that the oplog has rolled past the resume
// token, MongoDB rejects the token with a "resume point too far in the past"
// error. We currently retry with the same stale token → infinite backoff loop.
// TODO: inspect the error code (286 / ChangeStreamHistoryLost) and retry
// without a token to restart the stream from the current oplog head.

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

let stream: ChangeStream<StoredEvent> | null = null;

// ── startChangeStream ─────────────────────────────────────────────────────────
// Opens a change stream on the events collection and calls onInsert for every
// new document. Automatically recovers from cursor failures using the last
// seen resume token. Returns a teardown function for graceful shutdown.

export function startChangeStream(
  onInsert: (event: StoredEvent) => void,
): () => Promise<void> {
  let resumeToken: ResumeToken | null = null;
  let retryDelayMs = RETRY_BASE_MS;
  let shuttingDown = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function open(): void {
    const options = resumeToken ? { resumeAfter: resumeToken } : {};

    stream = getDb()
      .collection<StoredEvent>(EVENTS_COLLECTION)
      .watch<StoredEvent>([{ $match: { operationType: "insert" } }], options);

    stream.on("change", (change) => {
      // Advance the cursor position on every delivered event.
      // This is the "at-least-once" checkpoint — if we crash immediately
      // after this line, we replay this event on restart. That's fine:
      // the idempotent insert in event.repository.ts absorbs duplicates.
      resumeToken = change._id;
      retryDelayMs = RETRY_BASE_MS; // successful delivery → reset backoff

      if (change.operationType === "insert" && change.fullDocument) {
        onInsert(change.fullDocument);
      }
    });

    stream.on("error", (err: Error) => {
      if (shuttingDown) return;
      console.error(
        `[changeStream] error — reopening in ${retryDelayMs}ms:`,
        err.message,
      );
      retryTimer = setTimeout(() => {
        retryTimer = null;
        open();
      }, retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
    });

    const label = resumeToken ? " (resuming from token)" : "";
    console.log(`[changeStream] watching "${EVENTS_COLLECTION}" for inserts${label}`);
  }

  open();

  return async () => {
    shuttingDown = true;
    // Cancel any pending retry before closing — otherwise the timer fires
    // after MongoDB has closed and open() throws into a dead connection.
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (stream && !stream.closed) {
      await stream.close();
    }
    console.log("[changeStream] shut down cleanly");
  };
}
