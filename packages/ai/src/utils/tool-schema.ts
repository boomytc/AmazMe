import type { JsonSchema } from "../types.ts";

export function validateArguments(schema: JsonSchema, args: unknown): string | undefined {
  if (schema.type !== "object") return undefined;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const record = args as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (record[key] === undefined) return `missing ${key}`;
  }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (record[key] === undefined) continue;
    if (property.type === "string" && typeof record[key] !== "string") return `${key} must be a string`;
    if (property.type === "number" && typeof record[key] !== "number") return `${key} must be a number`;
    if (property.type === "boolean" && typeof record[key] !== "boolean") return `${key} must be a boolean`;
  }
  return undefined;
}

export function toolDefinition(tool: { name: string; description: string; parameters: JsonSchema }) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
