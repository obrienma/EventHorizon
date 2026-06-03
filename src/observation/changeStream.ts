import type { ChangeStream, ResumeToken } from "mongodb";
import { getDb } from "../storage/db.js";
import { EVENTS_COLLECTION } from "../storage/event.repository.js";
import type { StoredEvent } from "../ingestion/event.schema.js";
import { loadResumeToken, saveResumeToken, clearResumeToken } from "./checkpoint.js";

// ── Pattern: Change Stream Recovery with Durable Checkpoint ──────────────────
// MongoDB change streams expose a resume token (change._id) on every event.
// It encodes the cursor's position in the replica set oplog. When a cursor
// dies (MongoDB restart, replica set election, network blip), we reopen the
// stream with { resumeAfter: lastResumeToken }. MongoDB replays any inserts
// that arrived between the crash and the reconnect — zero gap delivery.
//
// The resume token is now persisted to MongoDB via checkpoint.ts. On startup
// we load the last saved token so pod restarts (k3s evictions, rolling deploys)
// don't lose the cursor position. A null token (first boot, or post-overrun
// clear) starts the stream at the current oplog head.
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
// Design Decision — fire-and-forget checkpoint writes:
// saveResumeToken() is not awaited in the "change" handler. A failed write is
// logged but does not interrupt event delivery or block the handler. Worst
// case: the token drifts slightly behind on the next pod restart. The event
// is still delivered to WebSocket clients; the durability guarantee slightly
// weakens but does not break.
//
// Known limitation — oplog overrun:
// If the server is down long enough that the oplog has rolled past the resume
// token, MongoDB rejects the token with error 286 (ChangeStreamHistoryLost).
// We detect the code, clear the stale checkpoint, reset backoff, and reopen
// from the current oplog head — accepting the gap. Without detection this
// would be an infinite retry loop with a permanently stale token.

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const OPLOG_OVERRUN_CODE = 286;

let stream: ChangeStream<StoredEvent> | null = null;

// ── startChangeStream ─────────────────────────────────────────────────────────
// Opens a change stream on the events collection and calls onInsert for every
// new document. Loads the persisted resume token on startup; persists it on
// every delivered event. Automatically recovers from cursor failures.
// Returns a teardown function for graceful shutdown.

export async function startChangeStream(
  onInsert: (event: StoredEvent) => void,
): Promise<() => Promise<void>> {
  let resumeToken: ResumeToken | null = await loadResumeToken();
  if (resumeToken) {
    console.log("[changeStream] loaded resume token from checkpoint");
  }

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
      resumeToken = change._id;
      retryDelayMs = RETRY_BASE_MS;

      // Persist the checkpoint — fire-and-forget.
      saveResumeToken(change._id).catch((err: Error) =>
        console.error("[changeStream] failed to persist resume token:", err.message),
      );

      if (change.operationType === "insert" && change.fullDocument) {
        onInsert(change.fullDocument);
      }
    });

    stream.on("error", (err: Error) => {
      if (shuttingDown) return;

      // ── Oplog overrun (ChangeStreamHistoryLost) ───────────────────────────
      // The oplog has rolled past our resume token. Clear the stale checkpoint
      // and restart from the current oplog head. Events inserted during the
      // gap are not replayed — this is the known and accepted failure mode.
      const code = (err as { code?: number }).code;
      if (code === OPLOG_OVERRUN_CODE) {
        console.warn(
          "[changeStream] oplog overrun (ChangeStreamHistoryLost) — " +
            "clearing stale checkpoint, restarting from oplog head. " +
            "Events during the gap will not be replayed to clients.",
        );
        resumeToken = null;
        retryDelayMs = RETRY_BASE_MS;
        clearResumeToken().catch((e: Error) =>
          console.error("[changeStream] failed to clear stale checkpoint:", e.message),
        );
      }

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
