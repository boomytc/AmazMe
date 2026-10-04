import { Compile } from "typebox/compile";
import { Format } from "typebox/format";
import { Resolve } from "typebox/schema";
import type { TLocalizedValidationError } from "typebox/error";
import type { TSchema } from "typebox";
import type { JsonSchema } from "../types.ts";

const schemaRef = { $ref: "#/$defs/schema" };
const schemaMap = { type: "object", additionalProperties: schemaRef };
const schemaArray = { type: "array", items: schemaRef };
const schemaMaps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const schemaChildren = ["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "unevaluatedItems", "contains", "not", "if", "then", "else"];
const schemaArrays = ["prefixItems", "allOf", "anyOf", "oneOf"];
const strings = { type: "array", items: { type: "string" }, uniqueItems: true };
const nonnegativeInteger = { type: "integer", minimum: 0 };
const properties: Record<string, unknown> = {
  type: { anyOf: [
    { enum: ["object", "array", "string", "number", "integer", "boolean", "null"] },
    { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["object", "array", "string", "number", "integer", "boolean", "null"] } },
  ] },
  $ref: { type: "string" },
  enum: { type: "array", minItems: 1, uniqueItems: true },
  const: {}, default: {}, examples: { type: "array" },
  required: strings,
  dependentRequired: { type: "object", additionalProperties: strings },
  multipleOf: { type: "number", exclusiveMinimum: 0 },
};
for (const key of ["$id", "$anchor", "$comment", "title", "description", "pattern"]) properties[key] = { type: "string" };
properties.$schema = { enum: ["https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema#"] };
properties.format = { enum: Format.Entries().map(([name]) => name) };
for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) properties[key] = { type: "number" };
for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minContains", "maxContains", "minProperties", "maxProperties"]) properties[key] = nonnegativeInteger;
for (const key of ["uniqueItems", "readOnly", "writeOnly", "deprecated"]) properties[key] = { type: "boolean" };
for (const key of schemaMaps) properties[key] = schemaMap;
for (const key of schemaChildren) properties[key] = schemaRef;
properties.prefixItems = schemaArray;
for (const key of ["allOf", "anyOf", "oneOf"]) properties[key] = { ...schemaArray, minItems: 1 };
const schemaObject = { type: "object", properties, patternProperties: { "^x-": {} }, additionalProperties: false };
// Validate schema structure first: Compile alone ignores unknown or malformed keywords.
const schemaValidator = Compile({ ...schemaObject, $defs: { schema: { anyOf: [{ type: "boolean" }, schemaObject] } } } as TSchema);
const validators = new WeakMap<object, { definition: string; validator: ReturnType<typeof Compile> }>();

export function validateArguments(schema: JsonSchema, args: unknown): string | undefined {
  try {
    const checked = validatorFor(schema);
    if (typeof checked === "string") return checked;
    if (checked.Check(args)) return undefined;
    const errors = checked.Errors(args).flatMap(formatError);
    return errors.length > 0 ? errors.join("; ") : "invalid arguments";
  } catch {
    // Schema compilation and unresolved references must fail before the tool runs.
    return "unsupported schema: could not compile a local JSON Schema";
  }
}

export function toolDefinition(tool: { name: string; description: string; parameters: JsonSchema }) {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

function validatorFor(schema: JsonSchema): ReturnType<typeof Compile> | string {
  const definition = JSON.stringify(schema);
  const cached = validators.get(schema);
  if (cached?.definition === definition) return cached.validator;
  const snapshot = JSON.parse(definition) as TSchema;
  if (!schemaValidator.Check(snapshot)) {
    return `unsupported schema: ${schemaValidator.Errors(snapshot).flatMap(formatError).join("; ")}`;
  }
  checkReferences(snapshot as Record<string, unknown>);
  const compiled = Compile(snapshot);
  validators.set(schema, { definition, validator: compiled });
  return compiled;
}

function checkReferences(root: Record<string, unknown>): void {
  const nodes: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const anchors = new Set<string>();
  const baseFor = (node: Record<string, unknown>) => {
    const base = Resolve.Base(root, "", node) ?? Resolve.DefaultBase;
    return typeof node.$id === "string" ? String(new URL(node.$id, base)) : base;
  };
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (seen.has(node)) return;
    seen.add(node);
    nodes.push(node);
    if (typeof node.$anchor === "string") {
      const anchor = `${baseFor(node)}#${node.$anchor}`;
      if (anchors.has(anchor)) throw new Error("Duplicate schema anchor");
      anchors.add(anchor);
    }
    for (const key of schemaMaps) {
      if (node[key]) for (const child of Object.values(node[key] as object)) collect(child);
    }
    for (const key of schemaChildren) collect(node[key]);
    for (const key of schemaArrays) {
      if (Array.isArray(node[key])) for (const child of node[key]) collect(child);
    }
  };
  collect(root);
  for (const node of nodes) {
    if (typeof node.$ref !== "string") continue;
    // Use the compiler's resolver for pointers, anchors and embedded $id scopes.
    // An empty remote context never fetches or resolves an external schema.
    const target = Resolve.Ref({}, root, baseFor(node), node.$ref, false);
    if (typeof target !== "boolean" && !schemaValidator.Check(target)) throw new Error("Invalid schema reference target");
    // A reference may turn data in default/annotations into an actual schema.
    // Traverse that target too, without interpreting unreferenced data as schema.
    collect(target);
  }
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
