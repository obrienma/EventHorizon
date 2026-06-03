import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { getDb } from "../storage/db.js";
import {
  loadResumeToken,
  saveResumeToken,
  clearResumeToken,
  CHECKPOINT_COLLECTION,
} from "./checkpoint.js";

vi.mock("../storage/db.js");

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  vi.mocked(getDb).mockReturnValue(client.db("test"));
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

beforeEach(async () => {
  await vi.mocked(getDb)().collection(CHECKPOINT_COLLECTION).deleteMany({});
});

// ── loadResumeToken ───────────────────────────────────────────────────────────

describe("loadResumeToken", () => {
  it("returns null when no checkpoint exists", async () => {
    expect(await loadResumeToken()).toBeNull();
  });

  it("returns the stored token after saveResumeToken", async () => {
    const token = { _data: "fake-oplog-position" };
    await saveResumeToken(token);
    expect(await loadResumeToken()).toEqual(token);
  });
});

// ── saveResumeToken ───────────────────────────────────────────────────────────

describe("saveResumeToken", () => {
  it("overwrites an existing token (upsert — only one document)", async () => {
    const first = { _data: "position-1" };
    const second = { _data: "position-2" };
    await saveResumeToken(first);
    await saveResumeToken(second);

    expect(await loadResumeToken()).toEqual(second);

    const count = await vi
      .mocked(getDb)()
      .collection(CHECKPOINT_COLLECTION)
      .countDocuments();
    expect(count).toBe(1);
  });

  it("sets updatedAt on the checkpoint document", async () => {
    await saveResumeToken({ _data: "pos" });
    const doc = await vi
      .mocked(getDb)()
      .collection<{ _id: string; token: unknown; updatedAt: Date }>(CHECKPOINT_COLLECTION)
      .findOne({ _id: "observation" });
    expect(doc?.updatedAt).toBeInstanceOf(Date);
  });
});

// ── clearResumeToken ──────────────────────────────────────────────────────────

describe("clearResumeToken", () => {
  it("removes the checkpoint so loadResumeToken returns null", async () => {
    await saveResumeToken({ _data: "pos" });
    await clearResumeToken();
    expect(await loadResumeToken()).toBeNull();
  });

  it("does not throw when no checkpoint exists", async () => {
    await expect(clearResumeToken()).resolves.toBeUndefined();
  });
});
