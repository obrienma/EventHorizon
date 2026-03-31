import { describe, it, expect } from "vitest";
import { classify } from "./classify.js";
import type { AppEvent } from "../ingestion/event.schema.js";

function makeEvent(overrides: Omit<AppEvent, "id" | "timestamp">): AppEvent {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("classify", () => {
  describe("pipeline events", () => {
    it("classifies failed pipeline as critical", () => {
      const result = classify(makeEvent({ source: "ci", type: "pipeline", payload: { pipelineId: "p1", step: "build", status: "failed" } }));
      expect(result.classification).toBe("critical");
      expect(result.tags).toContain("failed");
    });

    it("classifies passed pipeline as normal", () => {
      const result = classify(makeEvent({ source: "ci", type: "pipeline", payload: { pipelineId: "p1", step: "test", status: "passed" } }));
      expect(result.classification).toBe("normal");
      expect(result.tags).toContain("passed");
    });

    it("classifies started pipeline as normal", () => {
      const result = classify(makeEvent({ source: "ci", type: "pipeline", payload: { pipelineId: "p1", step: "deploy", status: "started" } }));
      expect(result.classification).toBe("normal");
      expect(result.tags).toContain("started");
    });
  });

  describe("sensor events", () => {
    it("includes the metric name in tags", () => {
      const result = classify(makeEvent({ source: "iot-rack-1", type: "sensor", payload: { sensorId: "s1", metric: "temperature", value: 22.5, unit: "C" } }));
      expect(result.tags).toContain("temperature");
    });

    it("flags temperature as critical when above 85°C", () => {
      const result = classify(makeEvent({ source: "iot-rack-1", type: "sensor", payload: { sensorId: "s1", metric: "temperature", value: 86, unit: "C" } }));
      expect(result.classification).toBe("critical");
    });

    it("flags temperature as warning when above 70°C", () => {
      const result = classify(makeEvent({ source: "iot-rack-1", type: "sensor", payload: { sensorId: "s1", metric: "temperature", value: 75, unit: "C" } }));
      expect(result.classification).toBe("warning");
    });
  });

  describe("app events", () => {
    it("includes the action in tags", () => {
      const result = classify(makeEvent({ source: "web", type: "app", payload: { action: "checkout" } }));
      expect(result.classification).toBe("normal");
      expect(result.tags).toContain("checkout");
    });
  });
});
