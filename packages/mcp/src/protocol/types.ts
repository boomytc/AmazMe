import type { BlobResourceContents, ContentAnnotations, TextResourceContents } from "./content.ts";
import type { JsonRpcId } from "./jsonrpc.ts";

/** Current specification revision. Modern requests carry this in `_meta`. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * Revisions that still open a session with `initialize`.
 * Kept so a modern client can fall back when `server/discover` is not a modern response.
 */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type LegacyProtocolVersion = (typeof LEGACY_PROTOCOL_VERSIONS)[number];
export type SupportedProtocolVersion = typeof MODERN_PROTOCOL_VERSION | LegacyProtocolVersion;

/** Newest revision this client speaks. */
export const LATEST_PROTOCOL_VERSION = MODERN_PROTOCOL_VERSION;

export type ProtocolEra = "modern" | "legacy";

export interface Implementation {
  name: string;
  version: string;
  title?: string;
}

export interface Root {
  uri: string;
  name?: string;
}

export interface ClientCapabilities {
  experimental?: Record<string, unknown>;
  roots?: { listChanged?: boolean };
  sampling?: Record<string, unknown>;
  elicitation?: Record<string, unknown>;
}

export interface ServerCapabilities {
  experimental?: Record<string, unknown>;
  logging?: Record<string, unknown>;
  prompts?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  tools?: { listChanged?: boolean };
  completions?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: Implementation;
  instructions?: string;
}

export interface DiscoverResult {
  supportedVersions: string[];
  capabilities: ServerCapabilities;
  instructions?: string;
  _meta?: Record<string, unknown>;
}

export interface ProgressNotification {
  progressToken: JsonRpcId;
  progress: number;
  total?: number;
  message?: string;
}

export interface CancelledNotification {
  requestId: JsonRpcId;
  reason?: string;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

export interface Resource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: ContentAnnotations;
  _meta?: Record<string, unknown>;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: ContentAnnotations;
  _meta?: Record<string, unknown>;
}

export interface ReadResourceResult {
  contents: Array<TextResourceContents | BlobResourceContents>;
  _meta?: Record<string, unknown>;
}

export function isLegacyProtocolVersion(version: string): version is LegacyProtocolVersion {
  return (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}
