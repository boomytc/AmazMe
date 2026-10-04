// Portions adapted from Pi packages/chord/src/json.ts, Copyright (c) 2025 Mario Zechner, MIT License. See NOTICE.
import { ProtocolError, resolveLimits, type ProtocolLimits } from "./errors.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type JsonLimits = Pick<ProtocolLimits, "maxDepth" | "maxItems">;

const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Throws unless the value is strict JSON: finite numbers, well-formed strings, dense plain arrays,
 * and plain or null-prototype objects whose own keys are enumerable string data properties.
 * Nothing is coerced, defaulted, or copied. Shared acyclic references count once per occurrence.
 */
export function assertJsonValue(value: unknown, limits?: Partial<JsonLimits>): asserts value is JsonValue {
  const resolved = resolveLimits(limits);
  new JsonChecker(resolved.maxDepth, resolved.maxItems).check(value, 0);
}

export function isJsonValue(value: unknown, limits?: Partial<JsonLimits>): value is JsonValue {
  try {
    assertJsonValue(value, limits);
    return true;
  } catch (error) {
    if (error instanceof ProtocolError) return false;
    throw error;
  }
}

class JsonChecker {
  private readonly maxDepth: number;
  private readonly maxItems: number;
  private items = 0;
  private readonly path: string[] = [];
  private readonly ancestors = new Set<object>();

  constructor(maxDepth: number, maxItems: number) {
    this.maxDepth = maxDepth;
    this.maxItems = maxItems;
  }

  check(value: unknown, depth: number): void {
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      if (LONE_SURROGATE.test(value)) this.fail("invalid_json", "string contains a lone surrogate");
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) this.fail("invalid_json", "number is not finite");
      return;
    }
    if (typeof value !== "object") this.fail("invalid_json", `${typeof value} is not JSON`);
    if (depth >= this.maxDepth) this.fail("limit_exceeded", `nesting exceeds ${this.maxDepth} levels`);
    if (this.ancestors.has(value)) this.fail("invalid_json", "value contains a cycle");
    this.ancestors.add(value);
    try {
      if (Array.isArray(value)) this.array(value, depth);
      else this.object(value, depth);
    } finally {
      this.ancestors.delete(value);
    }
  }

  private array(value: unknown[], depth: number): void {
    if (Object.getPrototypeOf(value) !== Array.prototype) this.fail("invalid_json", "array is not a plain array");
    if (Reflect.ownKeys(value).length !== value.length + 1) this.fail("invalid_json", "array is sparse or has extra keys");
    this.count(value.length);
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      this.path.push(`[${index}]`);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) this.fail("invalid_json", "array element is not a data property");
      this.check(descriptor.value, depth + 1);
      this.path.pop();
    }
  }

  private object(value: object, depth: number): void {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) this.fail("invalid_json", "object is not a plain object");
    const keys = Reflect.ownKeys(value);
    this.count(keys.length);
    for (const key of keys) {
      if (typeof key === "symbol") this.fail("invalid_json", "object has a symbol key");
      this.path.push(`.${key.length > 32 ? `${key.slice(0, 32)}…` : key}`);
      if (LONE_SURROGATE.test(key)) this.fail("invalid_json", "key contains a lone surrogate");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) this.fail("invalid_json", "property is not an enumerable data property");
      this.check(descriptor.value, depth + 1);
      this.path.pop();
    }
  }

  private count(items: number): void {
    this.items += items;
    if (this.items > this.maxItems) this.fail("limit_exceeded", `value exceeds ${this.maxItems} items`);
  }

  private fail(code: "invalid_json" | "limit_exceeded", reason: string): never {
    const path = this.path.slice(0, 16).join("");
    throw new ProtocolError(code, `$${path}${this.path.length > 16 ? "…" : ""}: ${reason}`);
  }
}
