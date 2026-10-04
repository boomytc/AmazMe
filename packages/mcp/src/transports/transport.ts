import { type JsonRpcId, type JsonRpcMessage, toError } from "../protocol/jsonrpc.ts";
import type { ProtocolEra, Tool } from "../protocol/types.ts";

export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type McpTransportMessageListener = (message: JsonRpcMessage) => void;
export type McpTransportErrorListener = (error: Error) => void;
export type McpTransportCloseListener = () => void;

export interface McpTransport {
  /**
   * `stream` probes with `server/discover` and treats a non-modern JSON-RPC error as legacy.
   * `http` uses the HTTP status and body rules from the 2026-07-28 Streamable HTTP transport.
   */
  readonly probe: "stream" | "http";
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: McpTransportMessageListener): () => void;
  onError(listener: McpTransportErrorListener): () => void;
  onClose(listener: McpTransportCloseListener): () => void;
  setProtocolVersion?(version: string): void;
  setEra?(era: ProtocolEra): void;
  /** Replace tools/list definitions used to mirror annotated arguments into HTTP headers. */
  setToolSchemas?(tools: readonly Tool[]): void;
  /** Stop one in-flight request. Streamable HTTP closes that response stream. */
  abortRequest?(id: JsonRpcId): void;
}

/** Listener bookkeeping shared by transports. `emitClose` fires at most once. */
export abstract class TransportEvents {
  private messageListeners = new Set<McpTransportMessageListener>();
  private errorListeners = new Set<McpTransportErrorListener>();
  private closeListeners = new Set<McpTransportCloseListener>();
  private closeEmitted = false;

  onMessage(listener: McpTransportMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  protected emitMessage(message: JsonRpcMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (error) {
        this.emitError(error);
      }
    }
  }

  protected emitError(error: unknown): void {
    const normalized = toError(error);
    for (const listener of this.errorListeners) {
      try {
        listener(normalized);
      } catch {
        // A diagnostic observer cannot stop delivery or transport cleanup.
      }
    }
  }

  protected emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch (error) {
        this.emitError(error);
      }
    }
  }
}
