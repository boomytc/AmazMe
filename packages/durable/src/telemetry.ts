import { defineTelemetrySchema } from "@amazme/telemetry";

/**
 * Diagnostic vocabulary for a durable drive.
 * `amazme.tool.execute` uses the same name as the in-memory agent, with this drive as its parent.
 * The two schemas are not combined in one starter.
 */
export const durableTelemetrySchema = defineTelemetrySchema({
  version: 1,
  spans: {
    "amazme.harness.drive": {
      description: "One drive of a durable lane operation.",
      parents: { kind: "root_or_external" },
      startAttributes: {
        lane: { type: "string", required: true, description: "Lane name", cardinality: "high" },
        operationId: { type: "string", required: true, description: "Operation id", cardinality: "high" },
      },
      endAttributes: {},
      events: {
        "amazme.harness.retry_wait": {
          description: "The drive is waiting until a retry time.",
          attributes: {},
        },
        "amazme.harness.recovered": {
          description: "A persisted effect was recovered; safe tools may replay unless cancellation was requested.",
          attributes: {
            effect: {
              type: "string",
              required: true,
              description: "Recovered effect",
              cardinality: "low",
              values: ["assistant", "summary", "tool"],
            },
            replay: {
              type: "string",
              required: false,
              description: "Tool replay policy used for recovery",
              cardinality: "low",
              values: ["safe", "never"],
            },
          },
        },
      },
      status: { default: "ok", errorWhen: "The drive fails or settles with a status other than completed." },
    },
    "amazme.tool.execute": {
      description: "One tool execution started by a durable drive.",
      parents: { kind: "spans", spans: ["amazme.harness.drive"] },
      startAttributes: {
        tool: { type: "string", required: true, description: "Tool name", cardinality: "low" },
        toolCallId: { type: "string", required: true, description: "Tool call id", cardinality: "high" },
      },
      endAttributes: {},
      status: { default: "ok", errorWhen: "The tool result is an error or the drive was aborted." },
    },
  },
});
