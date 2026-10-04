import { isObject } from "./jsonrpc.ts";

export interface ContentAnnotations {
  audience?: Array<"user" | "assistant">;
  priority?: number;
  lastModified?: string;
}

export interface TextContent {
  type: "text";
  text: string;
  annotations?: ContentAnnotations;
  _meta?: Record<string, unknown>;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
  _meta?: Record<string, unknown>;
}

export interface AudioContent {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
  _meta?: Record<string, unknown>;
}

export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: ContentAnnotations;
  _meta?: Record<string, unknown>;
}

export interface TextResourceContents {
  uri: string;
  mimeType?: string;
  text: string;
  _meta?: Record<string, unknown>;
}

export interface BlobResourceContents {
  uri: string;
  mimeType?: string;
  blob: string;
  _meta?: Record<string, unknown>;
}

export interface EmbeddedResourceContent {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: ContentAnnotations;
  _meta?: Record<string, unknown>;
}

export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLinkContent | EmbeddedResourceContent;

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function validContentMetadata(value: Record<string, unknown>): boolean {
  if (value._meta !== undefined && !isObject(value._meta)) return false;
  if (value.annotations === undefined) return true;
  const annotations = value.annotations;
  return isObject(annotations) &&
    (annotations.audience === undefined || (Array.isArray(annotations.audience) && annotations.audience.every((role) => role === "user" || role === "assistant"))) &&
    (annotations.priority === undefined || (typeof annotations.priority === "number" && Number.isFinite(annotations.priority) && annotations.priority >= 0 && annotations.priority <= 1)) &&
    optionalString(annotations, "lastModified");
}

/** Validate decoded resource payloads before they are projected into model messages. */
export function isResourceContents(value: unknown): value is TextResourceContents | BlobResourceContents {
  return isObject(value) && typeof value.uri === "string" && optionalString(value, "mimeType") &&
    optionalString(value, "text") && optionalString(value, "blob") &&
    (typeof value.text === "string" || typeof value.blob === "string") &&
    (value._meta === undefined || isObject(value._meta));
}

/** The wire can contain arbitrary JSON; the public content types require these fields. */
export function isContentBlock(value: unknown): value is ContentBlock {
  if (!isObject(value) || !validContentMetadata(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
    case "audio":
      return typeof value.data === "string" && typeof value.mimeType === "string";
    case "resource_link":
      return typeof value.uri === "string" && typeof value.name === "string" &&
        ["title", "description", "mimeType"].every((key) => optionalString(value, key)) &&
        (value.size === undefined || (typeof value.size === "number" && Number.isFinite(value.size) && value.size >= 0));
    case "resource":
      return isResourceContents(value.resource);
    default:
      return false;
  }
}

/** Text and base64 images a model request can carry. This package does not import a model SDK. */
export type LlmContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function blockToLlmContent(block: ContentBlock): LlmContent {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", data: block.data, mimeType: block.mimeType };
    case "audio":
      return { type: "text", text: `[audio ${block.mimeType} omitted]` };
    case "resource_link":
      return { type: "text", text: `${block.name}: ${block.uri}` };
    case "resource": {
      const resource = block.resource;
      if ("text" in resource) return { type: "text", text: resource.text };
      if (resource.mimeType?.startsWith("image/")) {
        return { type: "image", data: resource.blob, mimeType: resource.mimeType };
      }
      return { type: "text", text: `[binary resource ${resource.uri} (${resource.mimeType ?? "unknown type"}) omitted]` };
    }
    default:
      return { type: "text", text: `[unsupported MCP content ${(block as { type: string }).type}]` };
  }
}

/**
 * Project a tool result onto text and images.
 * Embedded text and image resources are unwrapped. Audio, resource links, and other
 * binary resources become short placeholders. With no blocks, `structuredContent` is JSON.
 */
export function toLlmContent(result: Pick<CallToolResult, "content" | "structuredContent">): LlmContent[] {
  const content = (result.content ?? []).map((block) => blockToLlmContent(block));
  if (content.length === 0 && result.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  }
  return content;
}
