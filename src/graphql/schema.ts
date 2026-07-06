export const typeDefs = `#graphql
  enum EventType { PIPELINE SENSOR APP }
  enum EventStatus { PROCESSED FAILED }
  enum Classification { NORMAL WARNING CRITICAL }

  interface Event {
    id: ID!
    timestamp: String!
    source: String!
    status: EventStatus!
    processed: ProcessedMeta
  }

  type PipelineEvent implements Event {
    id: ID!
    timestamp: String!
    source: String!
    status: EventStatus!
    processed: ProcessedMeta
    pipelineId: String!
    step: String!
    stepStatus: String!
    durationMs: Int
  }

  type SensorEvent implements Event {
    id: ID!
    timestamp: String!
    source: String!
    status: EventStatus!
    processed: ProcessedMeta
    sensorId: String!
    metric: String!
    value: Float!
    unit: String!
  }

  type AppTelemetryEvent implements Event {
    id: ID!
    timestamp: String!
    source: String!
    status: EventStatus!
    processed: ProcessedMeta
    action: String!
    userId: String
  }

  type ProcessedMeta {
    receivedAt: String!
    enrichedAt: String!
    classification: Classification!
    tags: [String!]!
  }

  type PipelineRun {
    pipelineId: ID!
    steps: [PipelineEvent!]!
    latestStepStatus: String!
  }

  type Stats {
    totalProcessed: Int!
    failedCount: Int!
    queueDepth: Int!
    queueDepthStatus: String!
    processingRatePerSec: Float!
    changeStreamLagMs: Float!
  }

  type Query {
    event(id: ID!): Event
    events(type: EventType, status: EventStatus, limit: Int = 50): [Event!]!
    pipelineRuns(limit: Int = 20): [PipelineRun!]!
    pipelineRun(pipelineId: ID!): PipelineRun
    stats: Stats!
  }
`;
