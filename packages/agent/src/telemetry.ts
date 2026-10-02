import { defineTelemetrySchema } from "@amazme/telemetry";

/**
 * Diagnostic vocabulary for the in-memory agent.
 * `amazme.tool.execute` is also recorded by the durable runtime, with that runtime's own parent.
 * The two schemas are not combined in one starter.
 */
export const agentTelemetrySchema = defineTelemetrySchema({
  version: 1,
  spans: {
    "amazme.agent.run": {
      description: "One in-memory agent prompt.",
      parents: { kind: "root_or_external" },
      startAttributes: {
        provider: { type: "string", required: true, description: "Active model provider", cardinality: "low" },
        model: { type: "string", required: true, description: "Active model id", cardinality: "high" },
      },
      endAttributes: {},
      status: { default: "ok", errorWhen: "The run throws, is cancelled, or an assistant message ends with error or aborted." },
    },
    "amazme.tool.execute": {
      description: "One tool execution started by the in-memory agent.",
      parents: { kind: "spans", spans: ["amazme.agent.run"] },
      startAttributes: {
        tool: { type: "string", required: true, description: "Tool name", cardinality: "low" },
        toolCallId: { type: "string", required: true, description: "Tool call id", cardinality: "high" },
      },
      endAttributes: {},
      status: { default: "ok", errorWhen: "The tool result is an error or the run was aborted." },
    },
  },
});
