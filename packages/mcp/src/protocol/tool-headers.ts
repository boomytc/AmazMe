import { isObject } from "./jsonrpc.ts";

export interface ToolHeaderMapping {
  path: readonly string[];
  name: string;
  type: "string" | "integer" | "boolean";
}

const FIELD_NAME = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/;
const DATA_KEYWORDS = new Set(["const", "default", "enum", "examples", "dependentRequired"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);

/** Extract the statically reachable primitive parameters described by the HTTP binding. */
export function extractToolHeaderMappings(schema: Record<string, unknown>): ToolHeaderMapping[] {
  const mappings: ToolHeaderMapping[] = [];
  const names = new Set<string>();
  const active = new Set<object>();
  function visit(value: unknown, path: readonly string[] | undefined): void {
    if (typeof value !== "object" || value === null) return;
    if (active.has(value)) throw new Error("Invalid x-mcp-header schema: cyclic schema");
    active.add(value);
    try {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, undefined);
        return;
      }
      if (!isObject(value)) return;
      if (Object.hasOwn(value, "x-mcp-header")) {
        const name = value["x-mcp-header"];
        if (typeof name !== "string" || !FIELD_NAME.test(name)) {
          throw new Error("Invalid x-mcp-header name: expected a nonempty HTTP field-name token");
        }
        if (!path || path.length === 0) {
          throw new Error("Invalid x-mcp-header path: only properties chains are allowed");
        }
        const declaredTypes = typeof value.type === "string" ? [value.type] : Array.isArray(value.type) ? value.type : [];
        const primitiveTypes = declaredTypes.filter((type) => type !== "null");
        const type = primitiveTypes.length === 1 ? primitiveTypes[0] : undefined;
        if (type !== "string" && type !== "integer" && type !== "boolean") {
          throw new Error("Invalid x-mcp-header type: expected string, integer, or boolean");
        }
        if (new Set(declaredTypes).size !== declaredTypes.length) {
          throw new Error("Invalid x-mcp-header type: duplicate schema type");
        }
        const normalized = name.toLowerCase();
        if (names.has(normalized)) throw new Error(`Invalid x-mcp-header name: duplicate ${name}`);
        names.add(normalized);
        mappings.push({ path, name, type });
      }
      for (const [key, child] of Object.entries(value)) {
        if (DATA_KEYWORDS.has(key)) continue;
        if (SCHEMA_MAPS.has(key) && isObject(child)) {
          for (const [property, propertySchema] of Object.entries(child)) {
            visit(propertySchema, key === "properties" && path !== undefined ? [...path, property] : undefined);
          }
        } else {
          visit(child, undefined);
        }
      }
    } finally {
      active.delete(value);
    }
  }
  visit(schema, []);
  return mappings;
}
