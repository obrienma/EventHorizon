import { MongoClient, type Db } from "mongodb";
import { config } from "../config.js";

// ── Pattern: Single Client Instance (Connection Pool) ────────────────────────
// MongoClient manages an internal pool (default 100 connections).
// Creating a new client per request would open 100 connections per call and
// exhaust the server's connection limit within seconds.
//
// Anti-Pattern Avoided: top-level await on import
// If connect() ran at module import time, any file that imports db.ts would
// attempt a real network connection — tests break, startup order can't be
// controlled. Instead: export connectDb() (called once at startup) and getDb()
// (called at the point of use). The module is inert on import.

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDb(): Promise<void> {
  client = new MongoClient(config.MONGO_URI);

  // connect() throws on network error — let it propagate.
  // Fail fast: if MongoDB is unreachable at startup, the worker should not
  // begin consuming messages it cannot persist.
  await client.connect();

  db = client.db(config.MONGO_DB_NAME);
  console.log(`[db] connected to "${config.MONGO_DB_NAME}"`);
}

export function getDb(): Db {
  if (!db) {
    // This is a programmer error (getDb called before connectDb).
    // A hard throw is correct — no graceful fallback makes sense here.
    throw new Error("[db] getDb() called before connectDb()");
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log("[db] connection closed");
  }
}
