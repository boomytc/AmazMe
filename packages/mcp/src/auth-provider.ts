export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UnauthorizedContext {
  /** The 401 response, or a 403 whose challenge reports `insufficient_scope`. */
  response: Response;
  serverUrl: URL;
  fetch: McpFetch;
  /** Access token the rejected request carried. A newer token means another request already refreshed it. */
  token?: string;
}

/**
 * Supplies bearer tokens to the Streamable HTTP transport.
 * OAuth discovery, PKCE, and credential storage implement this interface from `oauth/`.
 * They are not methods on the interface itself.
 */
export interface AuthProvider {
  token(): Promise<string | undefined>;
  onUnauthorized?(context: UnauthorizedContext): Promise<void>;
}
