import { defineTelemetrySchema } from "@amazme/telemetry";

/** Diagnostic vocabulary for model requests. Attribute names and values are derived from this object. */
export const aiTelemetrySchema = defineTelemetrySchema({
  version: 1,
  spans: {
    "amazme.ai.request": {
      description: "One model request, from dispatch through its terminal message.",
      parents: { kind: "any" },
      startAttributes: {
        provider: { type: "string", required: true, description: "Provider id", cardinality: "low" },
        model: { type: "string", required: true, description: "Model id", cardinality: "high" },
        api: { type: "string", required: true, description: "Protocol id", cardinality: "low" },
      },
      endAttributes: {
        stopReason: {
          type: "string",
          description: "Terminal stop reason",
          cardinality: "low",
          values: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"],
        },
        inputTokens: { type: "number", description: "Input tokens on the terminal message", cardinality: "high" },
        outputTokens: { type: "number", description: "Output tokens on the terminal message", cardinality: "high" },
        totalTokens: { type: "number", description: "Total tokens on the terminal message", cardinality: "high" },
      },
      status: { default: "ok", errorWhen: "The terminal stop reason is error or aborted." },
    },
  },
});
