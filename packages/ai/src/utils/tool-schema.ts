import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { TSchema } from "typebox";
import type { JsonSchema, JsonSchemaType } from "../types.ts";

const schemaTypes = new Set<JsonSchemaType>(["object", "array", "string", "number", "integer", "boolean", "null"]);
const objectKeys = new Set(["type", "description", "properties", "required", "additionalProperties"]);
const arrayKeys = new Set(["type", "description", "items"]);
const scalarKeys = new Set(["type", "description"]);
const validators = new WeakMap<object, { definition: string; validator: ReturnType<typeof Compile> }>();

export function validateArguments(schema: JsonSchema, args: unknown): string | undefined {
  const unsupported = unsupportedSchema(schema, "");
  if (unsupported) return unsupported;
  const validator = validatorFor(schema);
  if (validator.Check(args)) return undefined;
  const errors = validator.Errors(args).flatMap(formatError);
  return errors.length > 0 ? errors.join("; ") : "invalid arguments";
}

export function toolDefinition(tool: { name: string; description: string; parameters: JsonSchema }) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function validatorFor(schema: JsonSchema): ReturnType<typeof Compile> {
  const definition = JSON.stringify(schema);
  const cached = validators.get(schema);
  if (cached?.definition === definition) return cached.validator;
  // Compilation and error reporting must use the same snapshot, even if tools later change their schema.
  const compiled = Compile(JSON.parse(definition) as TSchema);
  validators.set(schema, { definition, validator: compiled });
  return compiled;
}

function unsupportedSchema(schema: unknown, path: string): string | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return `unsupported schema at ${path || "$"}: schema must be an object`;
  }
  const record = schema as Record<string, unknown>;
  if (typeof record.type !== "string" || !schemaTypes.has(record.type as JsonSchemaType)) {
    return `unsupported schema at ${path || "$"}: type must be object, array, string, number, integer, boolean, or null`;
  }
  const type = record.type as JsonSchemaType;
  const allowed = type === "object" ? objectKeys : type === "array" ? arrayKeys : scalarKeys;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return `unsupported schema at ${path || "$"}: keyword "${key}" is not supported`;
  }
  if ("description" in record && typeof record.description !== "string") {
    return `unsupported schema at ${path || "$"}: description must be a string`;
  }
  if (type === "object") return unsupportedObject(record, path);
  if (type === "array" && "items" in record) return unsupportedSchema(record.items, join(path, "items"));
  return undefined;
}

function unsupportedObject(record: Record<string, unknown>, path: string): string | undefined {
  if ("additionalProperties" in record && typeof record.additionalProperties !== "boolean") {
    return `unsupported schema at ${join(path, "additionalProperties")}: additionalProperties must be a boolean`;
  }
  if ("required" in record) {
    if (!Array.isArray(record.required) || record.required.some((item) => typeof item !== "string")) {
      return `unsupported schema at ${join(path, "required")}: required must be an array of strings`;
    }
  }
  if (!("properties" in record)) return undefined;
  if (record.properties === null || typeof record.properties !== "object" || Array.isArray(record.properties)) {
    return `unsupported schema at ${join(path, "properties")}: properties must be an object`;
  }
  for (const [name, child] of Object.entries(record.properties)) {
    const error = unsupportedSchema(child, join(path, name));
    if (error) return error;
  }
  return undefined;
}

function formatError(error: TLocalizedValidationError): string[] {
  if (error.keyword === "boolean") return [];
  if (error.keyword === "required") {
    const base = dotted(error.instancePath);
    return error.params.requiredProperties.map((name) => `${join(base, name)}: required`);
  }
  if (error.keyword === "additionalProperties") {
    const base = dotted(error.instancePath);
    return error.params.additionalProperties.map((name) => `${join(base, name)}: additional property is not allowed`);
  }
  if (error.keyword === "type") {
    const expected = Array.isArray(error.params.type) ? error.params.type.join(" or ") : error.params.type;
    return [`${dotted(error.instancePath) || "$"}: must be ${expected}`];
  }
  return [`${dotted(error.instancePath) || "$"}: ${error.message}`];
}

function dotted(instancePath: string): string {
  return instancePath.replace(/^\//, "").replaceAll("/", ".");
}

function join(base: string, name: string): string {
  return base ? `${base}.${name}` : name;
}
