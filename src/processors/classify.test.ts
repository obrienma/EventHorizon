import { describe, it, expect } from "vitest";
import { classify } from "./classify.js";
import type { AppEvent } from "../ingestion/event.schema.js";

describe("classify", () => {
  describe("pipeline events", () => {
    it("classifies failed pipeline as critical", () => {
      const event: AppEvent = {
        id: "00000000-0000-0000-0000-000000000001",
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "ci",
        type: "pipeline",
        payload: { pipelineId: "p1", step: "build", status: "failed" },
      };
      const result = classify(event);
      expect(result.classification).toBe("critical");
      expect(result.tags).toContain("failed");
    });

    it("classifies passed pipeline as normal", () => {
      const event: AppEvent = {
        id: "00000000-0000-0000-0000-000000000002",
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "ci",
        type: "pipeline",
        payload: { pipelineId: "p1", step: "test", status: "passed" },
      };
      const result = classify(event);
      expect(result.classification).toBe("normal");
      expect(result.tags).toContain("passed");
    });

    it("classifies started pipeline as normal", () => {
      const event: AppEvent = {
        id: "00000000-0000-0000-0000-000000000003",
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "ci",
        type: "pipeline",
        payload: { pipelineId: "p1", step: "deploy", status: "started" },
      };
      const result = classify(event);
      expect(result.classification).toBe("normal");
      expect(result.tags).toContain("started");
    });
  });

  describe("sensor events", () => {
    it("includes the metric name in tags", () => {
      const event: AppEvent = {
        id: "00000000-0000-0000-0000-000000000004",
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "iot-rack-1",
        type: "sensor",
        payload: { sensorId: "s1", metric: "temperature", value: 22.5, unit: "C" },
      };
      const result = classify(event);
      expect(result.tags).toContain("temperature");
    });
  });

  describe("app events", () => {
    it("includes the action in tags", () => {
      const event: AppEvent = {
        id: "00000000-0000-0000-0000-000000000005",
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "web",
        type: "app",
        payload: { action: "checkout" },
      };
      const result = classify(event);
      expect(result.classification).toBe("normal");
      expect(result.tags).toContain("checkout");
    });
  });
});
