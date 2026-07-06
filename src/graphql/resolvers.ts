import type { Filter } from "mongodb";
import { getDb } from "../storage/db.js";
import { EVENTS_COLLECTION } from "../storage/event.repository.js";
import { getStatsSnapshot } from "../observation/metrics.js";
import type { GraphQLContext } from "./loaders.js";
import type { StoredEvent, EventType } from "../ingestion/event.schema.js";

// ── Field-resolver helpers ────────────────────────────────────────────────────
// __resolveType only guarantees *which* concrete resolver map GraphQL calls —
// it doesn't narrow `doc.raw` for TypeScript within that map. These helpers do
// the narrowing explicitly; the throw is unreachable in practice (it would mean
// __resolveType and a field resolver disagree on the document's type) but keeps
// the payload accessors total functions rather than silently wrong ones.

function pipelinePayload(doc: StoredEvent) {
  if (doc.raw.type !== "pipeline") {
    throw new Error("[graphql] resolver type mismatch: expected pipeline event");
  }
  return doc.raw.payload;
}

function sensorPayload(doc: StoredEvent) {
  if (doc.raw.type !== "sensor") {
    throw new Error("[graphql] resolver type mismatch: expected sensor event");
  }
  return doc.raw.payload;
}

function appPayload(doc: StoredEvent) {
  if (doc.raw.type !== "app") {
    throw new Error("[graphql] resolver type mismatch: expected app event");
  }
  return doc.raw.payload;
}

// ── Shared Event interface fields ─────────────────────────────────────────────
// Identical across all three concrete types — defined once, spread into each.

const commonEventFields = {
  id: (doc: StoredEvent) => doc.raw.id,
  timestamp: (doc: StoredEvent) => doc.raw.timestamp,
  source: (doc: StoredEvent) => doc.raw.source,
  status: (doc: StoredEvent) => doc.status,
  processed: (doc: StoredEvent) => (doc.status === "processed" ? doc.processed : null),
};

// ── Query args ────────────────────────────────────────────────────────────────
// Hard ceiling on any client-supplied limit, regardless of the schema's
// default — an unbounded client-supplied limit would force an unbounded scan.

const QUERY_LIMIT_CAP = 200;

interface EventsArgs {
  type?: EventType;
  status?: "processed" | "failed";
  limit?: number;
}

interface PipelineRunsArgs {
  limit?: number;
}

interface PipelineRunArgs {
  pipelineId: string;
}

// A PipelineRun's identity as it flows through the resolver chain — steps and
// latestStepStatus are both derived from this single id via the DataLoader.
interface PipelineRunParent {
  pipelineId: string;
}

function latestStep(steps: StoredEvent[]): StoredEvent {
  if (steps.length === 0) {
    // Append-only storage means a pipelineId already confirmed to exist
    // (via distinct() or the existence check in Query.pipelineRun) cannot
    // lose its steps out from under a later load() — this would be a bug.
    throw new Error("[graphql] pipelineRun resolved with zero steps");
  }
  return steps.reduce((latest, step) =>
    new Date(step.raw.timestamp).getTime() > new Date(latest.raw.timestamp).getTime() ? step : latest,
  );
}

export const resolvers = {
  // Enum value maps: GraphQL's external UPPERCASE enum names map to the
  // lowercase internal strings the Zod schema and MongoDB documents already
  // use, so resolvers pass those internal values straight through with no
  // case-conversion logic of their own.
  EventType: { PIPELINE: "pipeline", SENSOR: "sensor", APP: "app" },
  EventStatus: { PROCESSED: "processed", FAILED: "failed" },
  Classification: { NORMAL: "normal", WARNING: "warning", CRITICAL: "critical" },

  Event: {
    __resolveType(doc: StoredEvent): string {
      const typeName: Record<EventType, string> = {
        pipeline: "PipelineEvent",
        sensor: "SensorEvent",
        app: "AppTelemetryEvent",
      };
      return typeName[doc.raw.type];
    },
  },

  PipelineEvent: {
    ...commonEventFields,
    pipelineId: (doc: StoredEvent) => pipelinePayload(doc).pipelineId,
    step: (doc: StoredEvent) => pipelinePayload(doc).step,
    stepStatus: (doc: StoredEvent) => pipelinePayload(doc).status,
    durationMs: (doc: StoredEvent) => pipelinePayload(doc).durationMs ?? null,
  },

  SensorEvent: {
    ...commonEventFields,
    sensorId: (doc: StoredEvent) => sensorPayload(doc).sensorId,
    metric: (doc: StoredEvent) => sensorPayload(doc).metric,
    value: (doc: StoredEvent) => sensorPayload(doc).value,
    unit: (doc: StoredEvent) => sensorPayload(doc).unit,
  },

  AppTelemetryEvent: {
    ...commonEventFields,
    action: (doc: StoredEvent) => appPayload(doc).action,
    userId: (doc: StoredEvent) => appPayload(doc).userId ?? null,
  },

  Query: {
    event: async (_parent: unknown, args: { id: string }) => {
      return getDb().collection<StoredEvent>(EVENTS_COLLECTION).findOne({ "raw.id": args.id });
    },

    events: async (_parent: unknown, args: EventsArgs) => {
      const limit = Math.min(args.limit ?? 50, QUERY_LIMIT_CAP);
      const filter: Filter<StoredEvent> = {};
      if (args.type) filter["raw.type"] = args.type;
      if (args.status) filter.status = args.status;

      return getDb()
        .collection<StoredEvent>(EVENTS_COLLECTION)
        .find(filter)
        .limit(limit)
        .toArray();
    },

    stats: () => getStatsSnapshot(),

    pipelineRuns: async (_parent: unknown, args: PipelineRunsArgs): Promise<PipelineRunParent[]> => {
      const limit = Math.min(args.limit ?? 20, QUERY_LIMIT_CAP);
      const pipelineIds = await getDb()
        .collection<StoredEvent>(EVENTS_COLLECTION)
        .distinct("raw.payload.pipelineId", { "raw.type": "pipeline" });

      return pipelineIds.slice(0, limit).map((pipelineId: string) => ({ pipelineId }));
    },

    pipelineRun: async (
      _parent: unknown,
      args: PipelineRunArgs,
    ): Promise<PipelineRunParent | null> => {
      const exists = await getDb()
        .collection<StoredEvent>(EVENTS_COLLECTION)
        .findOne({ "raw.type": "pipeline", "raw.payload.pipelineId": args.pipelineId });

      return exists ? { pipelineId: args.pipelineId } : null;
    },
  },

  // parent here is the { pipelineId } shape returned by Query.pipelineRuns /
  // Query.pipelineRun above, not a StoredEvent — steps and latestStepStatus
  // are both derived from the id via the per-request DataLoader in context,
  // so N runs in one request cost one $in query, not N.
  PipelineRun: {
    steps: (parent: PipelineRunParent, _args: unknown, context: GraphQLContext) => {
      return context.pipelineStepsLoader.load(parent.pipelineId);
    },
    latestStepStatus: async (
      parent: PipelineRunParent,
      _args: unknown,
      context: GraphQLContext,
    ): Promise<string> => {
      const steps = await context.pipelineStepsLoader.load(parent.pipelineId);
      const latest = latestStep(steps);
      return pipelinePayload(latest).status;
    },
  },
};
