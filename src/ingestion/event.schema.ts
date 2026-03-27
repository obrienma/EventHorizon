import { z } from "zod";
import type { ObjectId } from "mongodb";

// ── Base ─────────────────────────────────────────────────────────────────────

const BaseEventSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  source: z.string().min(1),
});

// ── Event types (discriminated union) ────────────────────────────────────────

const PipelineEventSchema = BaseEventSchema.extend({
  type: z.literal("pipeline"),
  payload: z.object({
    pipelineId: z.string().min(1),
    step: z.string().min(1),
    status: z.enum(["started", "passed", "failed"]),
    durationMs: z.number().int().nonnegative().optional(),
  }),
});

const SensorEventSchema = BaseEventSchema.extend({
  type: z.literal("sensor"),
  payload: z.object({
    sensorId: z.string().min(1),
    metric: z.enum(["temperature", "humidity", "pressure"]),
    // TODO: add a Zod refinement for value — sensor readings have physical bounds,
    // what constraint makes sense here?
    value: z.number(),
    unit: z.string().min(1),
  }),
});

const AppTelemetryEventSchema = BaseEventSchema.extend({
  type: z.literal("app"),
  payload: z.object({
    action: z.string().min(1),
    userId: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const EventSchema = z.discriminatedUnion("type", [
  PipelineEventSchema,
  SensorEventSchema,
  AppTelemetryEventSchema,
]);

// ── Inferred types ────────────────────────────────────────────────────────────

export type PipelineEvent = z.infer<typeof PipelineEventSchema>;
export type SensorEvent = z.infer<typeof SensorEventSchema>;
export type AppTelemetryEvent = z.infer<typeof AppTelemetryEventSchema>;
export type AppEvent = z.infer<typeof EventSchema>;
export type EventType = AppEvent["type"];

// ── Processed metadata (written once by worker) ───────────────────────────────

export type Classification = "normal" | "warning" | "critical";

export interface ProcessedMeta {
  receivedAt: Date;
  enrichedAt: Date;
  classification: Classification;
  tags: string[];
}

// ── StoredEvent (MongoDB document shape) ─────────────────────────────────────
// "queued" is RabbitMQ state — documents only enter MongoDB after the worker
// runs, so the only possible statuses at rest are "processed" and "failed".

export type StoredEvent =
  | { _id: ObjectId; raw: AppEvent; status: "processed"; processed: ProcessedMeta }
  | { _id: ObjectId; raw: AppEvent; status: "failed" };

// ── WebSocket message protocol ────────────────────────────────────────────────

export interface StatsPayload {
  totalProcessed: number;
  failedCount: number;
  queueDepth: number;
  queueDepthStatus: "ok" | "warning" | "critical";
  processingRatePerSec: number;
  changeStreamLagMs: number;
  eventTypeDistribution: Record<EventType, number>;
}

export type WsMessage =
  | { type: "event"; data: StoredEvent }
  | { type: "stats"; data: StatsPayload }
  | { type: "ping" };
