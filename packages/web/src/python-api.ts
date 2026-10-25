/// <reference lib="dom" />
import contracts from "./python-schema.json" with { type: "json" };
import type { ApiModels, HttpOperations } from "./python-contracts.ts";

type Schema = boolean | {
	readonly [keyword: string]: unknown;
	readonly $ref?: string;
	readonly const?: unknown;
	readonly enum?: readonly unknown[];
	readonly anyOf?: readonly Schema[];
	readonly oneOf?: readonly Schema[];
	readonly type?: string;
	readonly properties?: Readonly<Record<string, Schema>>;
	readonly additionalProperties?: Schema;
	readonly required?: readonly string[];
	readonly items?: Schema;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
};
const definitions: Readonly<Record<string, Schema>> = contracts.$defs;
const operations: Readonly<Record<string, { readonly response: Schema; readonly body: Schema | null }>> = contracts.operations;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The wire schema and TypeScript types have the same Python source. */
function matches(value: unknown, schema: Schema): boolean {
	if (typeof schema === "boolean") return schema;
	if (schema.$ref) {
		const target = definitions[schema.$ref.split("/").at(-1) ?? ""];
		return target !== undefined && matches(value, target);
	}
	if ("const" in schema && value !== schema.const) return false;
	if (schema.enum && !schema.enum.includes(value)) return false;
	if (schema.anyOf) return schema.anyOf.some(option => matches(value, option));
	if (schema.oneOf) return schema.oneOf.filter(option => matches(value, option)).length === 1;
	switch (schema.type) {
		case undefined: return true;
		case "null": return value === null;
		case "boolean": return typeof value === "boolean";
		case "integer":
		case "number":
			return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isSafeInteger(value)) &&
				(schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum) &&
				(schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum) && (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum);
		case "string":
			return typeof value === "string" && (schema.minLength === undefined || [...value].length >= schema.minLength) &&
				(schema.maxLength === undefined || [...value].length <= schema.maxLength) && (!schema.pattern || new RegExp(schema.pattern).test(value));
		case "array":
			return Array.isArray(value) && (schema.minItems === undefined || value.length >= schema.minItems) &&
				(schema.maxItems === undefined || value.length <= schema.maxItems) && value.every(item => matches(item, schema.items ?? true));
		case "object":
			return isRecord(value) && (schema.required ?? []).every(key => Object.hasOwn(value, key)) &&
				Object.entries(value).every(([key, item]) => matches(item, schema.properties?.[key] ?? schema.additionalProperties ?? true));
		default: throw new Error(`不支持的后端契约类型：${schema.type}`);
	}
}

export function parseContract<K extends keyof ApiModels>(name: K, value: unknown): ApiModels[K] {
	if (!matches(value, definitions[name])) throw new Error(`后端响应不符合契约：${name}`);
	return value as ApiModels[K];
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, value: unknown) {
		const code = isRecord(value) && typeof value.code === "string" ? value.code : `http_${status}`;
		super(isRecord(value) && typeof value.message === "string" ? value.message : code);
		this.status = status;
		this.code = code;
	}
}
const bindingErrors = new Set(["stale_client_binding", "stale_host_epoch", "build_mismatch", "attachment_expired"]);
export function definitive(error: unknown): boolean {
	return error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status) && !bindingErrors.has(error.code);
}

export function validateRequest<K extends keyof HttpOperations>(operation: K, body: unknown): void {
 const spec = operations[operation];
 if (spec.body && !matches(body, spec.body)) throw new Error(`请求不符合后端契约：${operation}`);
}
export function parseResponse<K extends keyof HttpOperations>(operation: K, value: unknown): HttpOperations[K]["response"] {
 if (!matches(value, operations[operation].response)) throw new Error(`后端响应不符合契约：${operation}`);
 return value as HttpOperations[K]["response"];
}
