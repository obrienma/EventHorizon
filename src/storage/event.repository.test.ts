import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { getDb } from "./db.js";
import { saveEvent, saveFailedEvent, ensureIndexes, EVENTS_COLLECTION } from "./event.repository.js";
import type { AppEvent, ProcessedMeta } from "../ingestion/event.schema.js";

// vi.mock is hoisted by vitest — db.ts is replaced before any import resolves.
// getDb() becomes a vi.fn() returning undefined by default.
// In beforeAll we inject a real Db from MongoMemoryServer via mockReturnValue.
vi.mock("./db.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testEvent: AppEvent = {
  id: "00000000-0000-0000-0000-000000000001",
  timestamp: "2026-01-01T00:00:00.000Z",
  source: "test",
  type: "app",
  payload: { action: "login" },
};

const testProcessed: ProcessedMeta = {
  receivedAt: new Date("2026-01-01T12:00:00.000Z"),
  enrichedAt: new Date("2026-01-01T12:00:00.001Z"),
  classification: "normal",
  tags: ["app", "login"],
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  vi.mocked(getDb).mockReturnValue(client.db("test"));
  // ensureIndexes() must run before tests — the unique index is what makes
  // the Idempotent Receiver tests meaningful.
  await ensureIndexes();
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

beforeEach(async () => {
  // Clear documents between tests; deleteMany leaves indexes intact.
  await vi.mocked(getDb)().collection(EVENTS_COLLECTION).deleteMany({});
});

// ── saveEvent ─────────────────────────────────────────────────────────────────

describe("saveEvent", () => {
  it("inserts a document with status 'processed' and correct fields", async () => {
    await saveEvent(testEvent, testProcessed);

    const doc = await vi.mocked(getDb)()
      .collection(EVENTS_COLLECTION)
      .findOne({ "raw.id": testEvent.id });

    expect(doc).not.toBeNull();
    expect(doc?.status).toBe("processed");
    expect(doc?.raw.id).toBe(testEvent.id);
    expect(doc?.processed.classification).toBe("normal");
    expect(doc?.processed.tags).toEqual(["app", "login"]);
  });

  it("does not throw on a duplicate insert (idempotent receiver)", async () => {
    await saveEvent(testEvent, testProcessed);
    await expect(saveEvent(testEvent, testProcessed)).resolves.toBeUndefined();
  });

  it("stores exactly one document after two identical inserts", async () => {
    await saveEvent(testEvent, testProcessed);
    await saveEvent(testEvent, testProcessed);

    const count = await vi.mocked(getDb)()
      .collection(EVENTS_COLLECTION)
      .countDocuments({ "raw.id": testEvent.id });

    expect(count).toBe(1);
  });
});

// ── saveFailedEvent ───────────────────────────────────────────────────────────

describe("saveFailedEvent", () => {
  it("inserts a document with status 'failed' and no processed field", async () => {
    await saveFailedEvent(testEvent);

    const doc = await vi.mocked(getDb)()
      .collection(EVENTS_COLLECTION)
      .findOne({ "raw.id": testEvent.id });

    expect(doc).not.toBeNull();
    expect(doc?.status).toBe("failed");
    expect(doc?.processed).toBeUndefined();
  });

  it("does not throw on a duplicate insert", async () => {
    await saveFailedEvent(testEvent);
    await expect(saveFailedEvent(testEvent)).resolves.toBeUndefined();
  });
});
