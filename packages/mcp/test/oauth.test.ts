import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import {
  adaptOAuthProvider,
  type AuthorizationServerMetadata,
  authorizeMcp,
  discoverAuthorizationServerMetadata,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  MemoryOAuthStateStore,
  type OAuthCallbackPage,
  OAuthCallbackServer,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthAuthorizationState,
  type OAuthDiscoveryState,
  OAuthError,
  exchangeAuthorizationCode,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  parseWwwAuthenticate,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  type OAuthTokens,
} from "@amazme/mcp/oauth";
import { type McpFetch, McpClient, StreamableHttpTransport, type UnauthorizedContext } from "@amazme/mcp";

class TestOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  client: OAuthClientInformationMixed | undefined;
  tokenSet: OAuthTokens | undefined;
  verifier: string | undefined;
  discovery: OAuthDiscoveryState | undefined;
  authorizationUrl: URL | undefined;
  authorization: OAuthAuthorizationState | undefined;
  requestedScopes: string | undefined;
  clientMetadataDocument?(metadata: AuthorizationServerMetadata | undefined): { url: string; redirectUrl: string } | undefined;

  constructor(redirectUrl: string, metadata: Partial<OAuthClientMetadata> = {}) {
    this.redirectUrl = redirectUrl;
    this.clientMetadata = {
      redirect_uris: [redirectUrl],
      client_name: "amazme-mcp-test",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...metadata,
    };
  }

  state(): string {
    return "expected-state";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.client;
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    this.client = information;
  }

  tokens(): OAuthTokens | undefined {
    return this.tokenSet;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.tokenSet = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("Missing code verifier");
    return this.verifier;
  }

  invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (kind === "all" || kind === "client") this.client = undefined;
    if (kind === "all" || kind === "tokens") this.tokenSet = undefined;
    if (kind === "all" || kind === "verifier") {
      this.verifier = undefined;
      this.authorization = undefined;
    }
    if (kind === "all") this.requestedScopes = undefined;
    if (kind === "all" || kind === "discovery") this.discovery = undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  saveAuthorizationState(authorization: OAuthAuthorizationState): void {
    this.authorization = structuredClone(authorization);
    this.verifier = authorization.codeVerifier;
    this.requestedScopes = authorization.scope;
  }

  authorizationState(): OAuthAuthorizationState | undefined {
    return structuredClone(this.authorization);
  }

  requestedScope(): string | undefined {
    return this.requestedScopes;
  }
}

const servers: Server[] = [];
const openSockets: Socket[] = [];

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-length": String(Buffer.byteLength(body)), ...headers });
  response.end(body);
}

function sendJson(response: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  send(response, status, JSON.stringify(body), { "content-type": "application/json", ...headers });
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse, origin: string) => Promise<void> | void,
): Promise<{ origin: string; mcpUrl: string }> {
  const server = createServer((request, response) => {
    const address = server.address();
    const origin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : "http://127.0.0.1";
    void Promise.resolve(handler(request, response, origin)).catch((error: unknown) => {
      if (response.writableEnded) return;
      send(response, 500, error instanceof Error ? error.message : String(error));
    });
  });
  server.on("connection", (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server has no port");
  servers.push(server);
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, mcpUrl: `${origin}/mcp` };
}

after(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function asUrl(input: string | URL): URL {
  return input instanceof URL ? input : new URL(input);
}

function formBody(body: BodyInit | null | undefined): URLSearchParams {
  if (typeof body === "string") return new URLSearchParams(body);
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams();
}

function authorizationMetadata(issuer: string, extras: Partial<AuthorizationServerMetadata> = {}): AuthorizationServerMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    ...extras,
  };
}

function challenge(
  auth: { onUnauthorized?(context: UnauthorizedContext): Promise<void> },
  context: UnauthorizedContext,
): Promise<void> {
  const onUnauthorized = auth.onUnauthorized;
  if (!onUnauthorized) throw new Error("OAuth adapter did not implement onUnauthorized");
  return onUnauthorized(context);
}

function strictFetch(route: (input: string | URL, init?: RequestInit) => Promise<Response>): McpFetch {
  return function (this: unknown, input, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return route(input, init);
  };
}

test("authorizes through HTTP, registers a native client, and refreshes a stale token", { timeout: 10_000 }, async () => {
  let expectedChallenge: string | undefined;
  let refreshes = 0;
  const registrations: Record<string, unknown>[] = [];
  const { origin, mcpUrl } = await listen(async (request, response, serverOrigin) => {
    const url = new URL(request.url ?? "/", serverOrigin);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      sendJson(response, {
        resource: `${serverOrigin}/mcp`,
        authorization_servers: [serverOrigin],
        scopes_supported: ["org:read"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(response, {
        issuer: serverOrigin,
        authorization_endpoint: `${serverOrigin}/authorize`,
        token_endpoint: `${serverOrigin}/token`,
        registration_endpoint: `${serverOrigin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register") {
      const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
      registrations.push(metadata);
      sendJson(response, { ...metadata, client_id: "test-client", client_secret: "" }, 201);
      return;
    }
    if (url.pathname === "/authorize") {
      expectedChallenge = url.searchParams.get("code_challenge") ?? undefined;
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "test-code");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: redirect.href, "content-length": "0" }).end();
      return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(await readBody(request));
      if (params.get("grant_type") === "refresh_token") {
        refreshes += 1;
        sendJson(response, { access_token: "refreshed-token", token_type: "Bearer", refresh_token: "", expires_in: null });
        return;
      }
      const challenge = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
      if (params.get("code") !== "test-code" || challenge !== expectedChallenge) {
        sendJson(response, { error: "invalid_grant" }, 400);
        return;
      }
      sendJson(response, { access_token: "first-token", refresh_token: "refresh-token", token_type: "Bearer", scope: "" });
      return;
    }
    if (url.pathname !== "/mcp") {
      send(response, 404, "");
      return;
    }
    if (request.method === "GET") {
      send(response, 405, "");
      return;
    }
    if (request.method === "DELETE") {
      send(response, 200, "");
      return;
    }
    const token = request.headers.authorization;
    if (token !== "Bearer first-token" && token !== "Bearer refreshed-token") {
      await readBody(request);
      send(response, 401, "Unauthorized", {
        "www-authenticate": `Bearer resource_metadata="${serverOrigin}/.well-known/oauth-protected-resource/mcp", scope=""`,
      });
      return;
    }
    const message = JSON.parse(await readBody(request)) as { id?: unknown; method?: string };
    if (message.id === undefined) {
      send(response, 202, "");
      return;
    }
    if (message.method === "server/discover") {
      sendJson(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "oauth-test", version: "1.0.0" } },
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      sendJson(response, {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "issues", inputSchema: { type: "object" } }] },
      });
      return;
    }
    sendJson(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  });

  const callback = await OAuthCallbackServer.listen();
  try {
    const provider = new TestOAuthProvider(callback.redirectUrl);
    const firstClient = new McpClient({ name: "oauth-test", version: "1.0.0" });
    await assert.rejects(
      firstClient.connect(new StreamableHttpTransport({
        url: mcpUrl,
        headers: { Authorization: "Bearer caller-supplied-stale-token" },
        authProvider: adaptOAuthProvider(provider),
        openGetStream: false,
      })),
      (error: unknown) => error instanceof McpOAuthAuthorizationRequiredError,
    );
    const authorizationUrl = provider.authorizationUrl;
    assert.ok(authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get("scope"), "org:read");
    assert.equal(authorizationUrl.searchParams.get("resource"), `${origin}/mcp`);
    assert.equal(authorizationUrl.searchParams.get("prompt"), null);
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.application_type, "native");
    assert.equal(provider.client?.client_id, "test-client");
    assert.equal(provider.client?.client_secret, undefined);
    const verifier = provider.verifier;
    assert.ok(verifier);
    assert.equal(
      authorizationUrl.searchParams.get("code_challenge"),
      createHash("sha256").update(verifier).digest("base64url"),
    );

    const callbackResult = callback.waitForCallback("expected-state");
    const authorizationResponse = await fetch(authorizationUrl, { redirect: "manual" });
    await fetch(authorizationResponse.headers.get("location") ?? "");
    const { code, state, iss } = await callbackResult;
    assert.equal(await authorizeMcp(provider, { serverUrl: mcpUrl, authorizationCode: code, state, iss, fetch }), "AUTHORIZED");

    const client = new McpClient({ name: "oauth-test", version: "1.0.0" });
    await client.connect(new StreamableHttpTransport({
      url: mcpUrl,
      headers: { Authorization: "Bearer caller-supplied-stale-token" },
      authProvider: adaptOAuthProvider(provider),
      openGetStream: false,
    }));
    assert.deepEqual(await client.listTools(), [{ name: "issues", inputSchema: { type: "object" } }]);
    await client.close();

    provider.tokenSet = { ...provider.tokenSet!, access_token: "stale-token" };
    const refreshedClient = new McpClient({ name: "oauth-test", version: "1.0.0" });
    await refreshedClient.connect(new StreamableHttpTransport({
      url: mcpUrl,
      headers: { Authorization: "Bearer caller-supplied-stale-token" },
      authProvider: adaptOAuthProvider(provider),
      openGetStream: false,
    }));
    assert.deepEqual(provider.tokenSet, {
      access_token: "refreshed-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      scope: "org:read",
    });
    assert.equal(refreshes, 1);
    await refreshedClient.close();
  } finally {
    await callback.close();
  }
});

test("shares one refresh between concurrent 401s when refresh tokens rotate", { timeout: 5_000 }, async () => {
  const grants: string[] = [];
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: ["not a url"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse(authorizationMetadata("https://mcp.example"));
    }
    if (url.pathname === "/token") {
      const refreshToken = formBody(init?.body).get("refresh_token") ?? "";
      grants.push(refreshToken);
      if (refreshToken !== "r1") return jsonResponse({ error: "invalid_grant" }, 400);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({ access_token: "a2", refresh_token: "r2", token_type: "Bearer", expires_in: 3600 });
    }
    return new Response("missing", { status: 404 });
  });
  const store = new MemoryOAuthStateStore();
  const provider = new McpOAuthProvider({
    serverUrl: "https://mcp.example/mcp",
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "test" },
    clientId: "client",
    store,
    onRedirect: () => undefined,
  });
  await provider.saveTokens({ access_token: "a1", refresh_token: "r1", token_type: "Bearer" });
  const auth = adaptOAuthProvider(provider);
  const unauthorized = () => ({
    response: new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } }),
    serverUrl: new URL("https://mcp.example/mcp"),
    fetch: fetchImpl,
    token: "a1",
  });
  await Promise.all([challenge(auth, unauthorized()), challenge(auth, unauthorized())]);
  await challenge(auth, unauthorized());
  assert.deepEqual(grants, ["r1"]);
  assert.equal(await auth.token(), "a2");
  const state = await store.load();
  assert.equal(state?.tokens?.refresh_token, "r2");
  assert.ok((state?.tokensExpireAt ?? 0) > Date.now() + 3_500_000);
});

test("asks for authorization instead of refreshing when the server needs more scope", { timeout: 5_000 }, async () => {
  let tokenPosts = 0;
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse(authorizationMetadata("https://mcp.example"));
    }
    if (url.pathname === "/token") {
      tokenPosts += 1;
      return jsonResponse({ error: "server_error" }, 500);
    }
    return new Response("missing", { status: 404 });
  });
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  provider.tokenSet = { access_token: "a1", refresh_token: "r1", token_type: "Bearer", scope: "repo read:org" };
  const auth = adaptOAuthProvider(provider);
  await assert.rejects(
    challenge(auth, {
      response: new Response(null, {
        status: 403,
        headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="repo admin"' },
      }),
      serverUrl: new URL("https://mcp.example/mcp"),
      fetch: fetchImpl,
      token: "a1",
    }),
    (error: unknown) => error instanceof McpOAuthAuthorizationRequiredError,
  );
  assert.equal(provider.authorizationUrl?.searchParams.get("scope"), "repo read:org admin");
  assert.equal(provider.authorizationUrl?.searchParams.get("prompt"), null);
  assert.equal(provider.tokenSet?.access_token, "a1");
  assert.equal(tokenPosts, 0);
});

test("requests the challenged scope and asks for consent when it includes offline_access", { timeout: 5_000 }, async () => {
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return jsonResponse({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://mcp.example"],
        scopes_supported: ["org:read"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse(authorizationMetadata("https://mcp.example"));
    }
    return new Response("missing", { status: 404 });
  });
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  const auth = adaptOAuthProvider(provider);
  await assert.rejects(
    challenge(auth, {
      response: new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer scope="files:read offline_access"' },
      }),
      serverUrl: new URL("https://mcp.example/mcp"),
      fetch: fetchImpl,
      token: "stale",
    }),
    (error: unknown) => error instanceof McpOAuthAuthorizationRequiredError,
  );
  assert.equal(provider.authorizationUrl?.searchParams.get("scope"), "files:read offline_access");
  assert.equal(provider.authorizationUrl?.searchParams.get("prompt"), "consent");
});

test("keeps persisted credentials bound to one MCP server URL", async () => {
  const store = new MemoryOAuthStateStore();
  const first = new McpOAuthProvider({
    serverUrl: "https://one.example/mcp",
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "test" },
    store,
    onRedirect: () => undefined,
  });
  await first.saveTokens({ access_token: "secret", token_type: "Bearer" });
  assert.equal((await first.tokens())?.access_token, "secret");
  const second = new McpOAuthProvider({
    serverUrl: "https://two.example/mcp",
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "test" },
    store,
    onRedirect: () => undefined,
  });
  assert.equal(await second.tokens(), undefined);
});

test("registers again when the authorization server issuer changes", { timeout: 5_000 }, async () => {
  const seen: string[] = [];
  let registered: Record<string, unknown> | undefined;
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    seen.push(url.href);
    if (url.hostname === "old.example") {
      return jsonResponse({ access_token: "should-not-save", token_type: "Bearer", refresh_token: "stolen" });
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return jsonResponse({
        resource: "https://mcp.example/mcp",
        authorization_servers: ["https://new.example"],
      });
    }
    if (url.hostname === "new.example" && url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return jsonResponse({
        ...authorizationMetadata("https://new.example"),
        registration_endpoint: "https://new.example/register",
      });
    }
    if (url.pathname === "/register") {
      registered = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ client_id: "new-client", redirect_uris: ["http://127.0.0.1/callback"] }, 201);
    }
    if (url.pathname === "/token") return jsonResponse({ access_token: "should-not-save", token_type: "Bearer" });
    return new Response("missing", { status: 404 });
  });
  const serverUrl = "https://mcp.example/mcp";
  const store = new MemoryOAuthStateStore();
  let authorizationUrl: URL | undefined;
  const provider = new McpOAuthProvider({
    serverUrl,
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "test" },
    store,
    onRedirect: (url) => {
      authorizationUrl = url;
    },
  });
  await store.save({
    serverUrl: String(new URL(serverUrl)),
    clientInformation: { client_id: "old-client", client_secret: "old-secret" },
    tokens: { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" },
    discovery: {
      authorizationServerUrl: "https://old.example",
      authorizationServerMetadata: {
        ...authorizationMetadata("https://old.example"),
        registration_endpoint: "https://old.example/register",
      },
    },
  });
  assert.equal(await authorizeMcp(provider, { serverUrl, fetch: fetchImpl }), "REDIRECT");
  assert.equal(seen.some((href) => href.includes("old.example")), false);
  assert.equal(seen.some((href) => new URL(href).pathname === "/token"), false);
  assert.equal(registered?.application_type, "native");
  assert.equal(JSON.stringify(registered).includes("old-secret"), false);
  assert.equal(authorizationUrl?.searchParams.get("client_id"), "new-client");
  assert.equal(await provider.tokens(), undefined);
  assert.equal((await store.load())?.clientInformation?.client_id, "new-client");
});

test("keeps a configured client id but does not send the old grant to a new issuer", { timeout: 5_000 }, async () => {
  const paths: string[] = [];
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    paths.push(`${url.hostname}${url.pathname}`);
    if (url.hostname === "old.example") return jsonResponse({ access_token: "nope", token_type: "Bearer" });
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: ["https://new.example"] });
    }
    if (url.hostname === "new.example" && url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return jsonResponse(authorizationMetadata("https://new.example"));
    }
    return new Response("missing", { status: 404 });
  });
  const serverUrl = "https://mcp.example/mcp";
  const store = new MemoryOAuthStateStore();
  let authorizationUrl: URL | undefined;
  const provider = new McpOAuthProvider({
    serverUrl,
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "test" },
    clientId: "pinned",
    store,
    onRedirect: (url) => {
      authorizationUrl = url;
    },
  });
  await provider.saveTokens({ access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" });
  await provider.saveDiscoveryState({
    authorizationServerUrl: "https://old.example",
    authorizationServerMetadata: authorizationMetadata("https://old.example"),
  });
  assert.equal(await authorizeMcp(provider, { serverUrl, fetch: fetchImpl }), "REDIRECT");
  assert.equal(paths.some((path) => path.includes("old.example") || path.endsWith("/token") || path.endsWith("/register")), false);
  assert.equal(authorizationUrl?.searchParams.get("client_id"), "pinned");
  assert.equal(await provider.tokens(), undefined);
});

test("treats a trailing slash change as another issuer without refreshing the old grant", { timeout: 5_000 }, async () => {
  const paths: string[] = [];
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    paths.push(url.pathname);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return jsonResponse({ resource: "https://idp.example/mcp", authorization_servers: ["https://idp.example"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") return jsonResponse(authorizationMetadata("https://idp.example"));
    if (url.pathname === "/token") {
      assert.equal(formBody(init?.body).get("refresh_token"), "keep-me");
      return jsonResponse({ access_token: "renewed", token_type: "Bearer" });
    }
    return new Response("missing", { status: 404 });
  });
  const serverUrl = "https://idp.example/mcp";
  const store = new MemoryOAuthStateStore();
  const provider = new McpOAuthProvider({
    serverUrl,
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "test" },
    clientId: "pinned",
    store,
    onRedirect: () => undefined,
  });
  await provider.saveTokens({ access_token: "old", refresh_token: "keep-me", token_type: "Bearer", expires_in: 30, scope: "read" });
  await provider.saveDiscoveryState({
    authorizationServerUrl: "https://idp.example/",
    authorizationServerMetadata: authorizationMetadata("https://idp.example/"),
  });
  assert.equal(await authorizeMcp(provider, { serverUrl, fetch: fetchImpl }), "REDIRECT");
  assert.equal(paths.includes("/register"), false);
  assert.equal(paths.includes("/token"), false);
  const state = await store.load();
  assert.equal(state?.tokens, undefined);
  assert.equal(state?.tokensExpireAt, undefined);
});

test("keeps the recorded issuer when protected resource metadata is unavailable", { timeout: 5_000 }, async () => {
  const calls: string[] = [];
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    calls.push(`${url.hostname}${url.pathname}`);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response("down", { status: 500 });
    if (url.hostname === "idp.example" && url.pathname === "/token") {
      assert.equal(formBody(init?.body).get("refresh_token"), "keep-me");
      return jsonResponse({ access_token: "renewed", token_type: "Bearer" });
    }
    if (url.hostname !== "idp.example") return new Response("missing", { status: 404 });
    return jsonResponse({ access_token: "stolen", token_type: "Bearer" });
  });
  const serverUrl = "https://mcp.example/mcp";
  const provider = new McpOAuthProvider({
    serverUrl,
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "test" },
    clientId: "pinned",
    onRedirect: () => {
      throw new Error("the recorded issuer should still refresh");
    },
  });
  await provider.saveTokens({ access_token: "old", refresh_token: "keep-me", token_type: "Bearer" });
  await provider.saveDiscoveryState({
    authorizationServerUrl: "https://idp.example",
    authorizationServerMetadata: authorizationMetadata("https://idp.example"),
    resourceMetadata: { resource: serverUrl },
  });
  assert.equal(await authorizeMcp(provider, { serverUrl, fetch: fetchImpl }), "AUTHORIZED");
  assert.equal((await provider.tokens())?.access_token, "renewed");
  assert.equal((await provider.tokens())?.refresh_token, "keep-me");
  assert.equal(calls.includes("idp.example/token"), true);
  assert.equal(calls.some((call) => call.startsWith("mcp.example") && call.endsWith("/token")), false);
  assert.equal((await provider.discoveryState())?.authorizationServerMetadata?.issuer, "https://idp.example");
});

test("rejects authorization metadata whose issuer does not match discovery", { timeout: 5_000 }, async () => {
  const fetched: string[] = [];
  await assert.rejects(
    discoverAuthorizationServerMetadata("https://idp.example", {
      fetch: strictFetch(async (input) => {
        fetched.push(asUrl(input).pathname);
        return jsonResponse({
          issuer: "https://attacker.example",
          authorization_endpoint: "https://idp.example/authorize",
          token_endpoint: "https://idp.example/token",
          response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        });
      }),
    }),
    (error: unknown) => error instanceof OAuthIssuerMismatchError,
  );
  assert.deepEqual(fetched, ["/.well-known/oauth-authorization-server"]);
});

test("tries protected-resource and authorization-server discovery URLs in order", { timeout: 5_000 }, async () => {
  const seen: { pathname: string; version: string | null; accept: string | null }[] = [];
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    const headers = new Headers(init?.headers);
    seen.push({ pathname: url.pathname, version: headers.get("mcp-protocol-version"), accept: headers.get("accept") });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return new Response(null, { status: 404 });
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: ["https://mcp.example/tenant"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/tenant") return new Response(null, { status: 404 });
    if (url.pathname === "/.well-known/openid-configuration/tenant") return new Response(null, { status: 404 });
    if (url.pathname === "/tenant/.well-known/openid-configuration") {
      return jsonResponse({
        ...authorizationMetadata("https://mcp.example/tenant"),
        authorization_endpoint: "https://mcp.example/tenant/authorize",
      });
    }
    return new Response("missing", { status: 500 });
  });
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  assert.equal(await authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }), "REDIRECT");
  assert.deepEqual(seen.map((item) => item.pathname), [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server/tenant",
    "/.well-known/openid-configuration/tenant",
    "/tenant/.well-known/openid-configuration",
  ]);
  assert.ok(seen.every((item) => item.version === "2026-07-28" && item.accept === "application/json"));
  assert.equal(`${provider.authorizationUrl?.origin}${provider.authorizationUrl?.pathname}`, "https://mcp.example/tenant/authorize");
  assert.equal(provider.authorizationUrl?.searchParams.get("resource"), "https://mcp.example/mcp");
});

test("stops discovery when authorization server metadata responds with 500", { timeout: 5_000 }, async () => {
  const seen: string[] = [];
  await assert.rejects(
    discoverAuthorizationServerMetadata("https://idp.example/tenant", {
      fetch: strictFetch(async (input) => {
        seen.push(asUrl(input).pathname);
        return new Response("down", { status: 500 });
      }),
    }),
    /HTTP 500 loading authorization server metadata/,
  );
  assert.deepEqual(seen, ["/.well-known/oauth-authorization-server/tenant"]);
});

test("rejects a protected resource on another origin before registration", { timeout: 5_000 }, async () => {
  let registered = false;
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return jsonResponse({ resource: "https://other.example/mcp", authorization_servers: ["https://mcp.example"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({ ...authorizationMetadata("https://mcp.example"), registration_endpoint: "https://mcp.example/register" });
    }
    if (url.pathname === "/register") {
      registered = true;
      return jsonResponse({ client_id: "new" }, 201);
    }
    return new Response("missing", { status: 404 });
  });
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  await assert.rejects(
    authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }),
    /does not match MCP server/,
  );
  assert.equal(registered, false);
});

test("uses a configured authorization server metadata document as given", { timeout: 5_000 }, async () => {
  const seen: string[] = [];
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    seen.push(url.pathname);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: ["https://mcp.example"] });
    }
    if (url.pathname === "/metadata.json") {
      return jsonResponse({
        issuer: "https://idp.example",
        authorization_endpoint: "https://mcp.example/idp/authorize",
        token_endpoint: "https://mcp.example/idp/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    return new Response("missing", { status: 404 });
  });
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  const serverUrl = "https://mcp.example/mcp";
  assert.equal(
    await authorizeMcp(provider, {
      serverUrl,
      authorizationServerMetadataUrl: new URL("https://mcp.example/metadata.json"),
      fetch: fetchImpl,
    }),
    "REDIRECT",
  );
  assert.equal(`${provider.authorizationUrl?.origin}${provider.authorizationUrl?.pathname}`, "https://mcp.example/idp/authorize");
  assert.equal(provider.authorizationUrl?.searchParams.get("resource"), serverUrl);
  assert.equal(seen.includes("/.well-known/oauth-authorization-server"), false);
  await assert.rejects(
    authorizeMcp(provider, {
      serverUrl,
      authorizationServerMetadataUrl: new URL("http://idp.example/metadata.json"),
      fetch: () => {
        throw new Error("insecure metadata was fetched");
      },
    }),
    (error: unknown) => error instanceof OAuthInsecureEndpointError,
  );
});

test("exchanges a code only when iss names the authorization server", { timeout: 5_000 }, async () => {
  const codes: string[] = [];
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    if (url.pathname !== "/token") throw new Error(`unexpected ${url.pathname}`);
    codes.push(formBody(init?.body).get("code") ?? "");
    return jsonResponse({ access_token: "token", token_type: "Bearer" });
  });
  const issuer = "https://idp.example";
  const exchange = (code: string, iss: string | undefined, issParameterSupported: boolean) => {
    const provider = new TestOAuthProvider("http://127.0.0.1/callback");
    provider.client = { client_id: "client" };
    provider.verifier = "verifier";
    provider.discovery = {
      authorizationServerUrl: issuer,
      authorizationServerMetadata: {
        ...authorizationMetadata(issuer),
        authorization_response_iss_parameter_supported: issParameterSupported,
      },
    };
    provider.saveAuthorizationState({ serverUrl: `${issuer}/mcp`, discovery: { ...provider.discovery, authorizationServerMetadata: provider.discovery.authorizationServerMetadata! }, clientInformation: provider.client, redirectUrl: provider.redirectUrl, codeVerifier: provider.verifier, state: "expected-state" });
    return authorizeMcp(provider, { serverUrl: `${issuer}/mcp`, authorizationCode: code, state: "expected-state", iss, fetch: fetchImpl });
  };
  await assert.rejects(exchange("other", "https://attacker.example", false), (error: unknown) => error instanceof OAuthIssuerMismatchError);
  await assert.rejects(exchange("missing", undefined, true), (error: unknown) => error instanceof OAuthIssuerMismatchError);
  assert.equal(await exchange("matching", issuer, true), "AUTHORIZED");
  assert.equal(await exchange("omitted", undefined, false), "AUTHORIZED");
  assert.deepEqual(codes, ["matching", "omitted"]);
});

test("keeps an explicit application_type on dynamic registration", { timeout: 5_000 }, async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({ ...authorizationMetadata("https://mcp.example"), registration_endpoint: "https://mcp.example/register" });
    }
    if (url.pathname === "/register") {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ client_id: "web-client", redirect_uris: body.redirect_uris }, 201);
    }
    return new Response("missing", { status: 404 });
  });
  const provider = new TestOAuthProvider("https://app.example/callback", { application_type: "web" });
  assert.equal(await authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }), "REDIRECT");
  assert.equal(body?.application_type, "web");
});

test("uses a client metadata document and does not register one", { timeout: 5_000 }, async () => {
  const paths: string[] = [];
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    paths.push(url.pathname);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({ ...authorizationMetadata("https://mcp.example"), client_id_metadata_document_supported: true });
    }
    if (url.pathname === "/register") return jsonResponse({ client_id: "should-not-register" }, 201);
    return new Response("missing", { status: 404 });
  });
  const document = { url: "https://app.example/oauth/client.json", redirectUrl: "http://127.0.0.1/callback/app" };
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.clientMetadataDocument = () => ({ url: "http://app.example/oauth/client.json", redirectUrl: document.redirectUrl });
  await assert.rejects(
    authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }),
    /Invalid OAuth client metadata URL/,
  );
  provider.clientMetadataDocument = () => ({ url: "https://app.example/", redirectUrl: document.redirectUrl });
  provider.discovery = undefined;
  await assert.rejects(
    authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }),
    /Invalid OAuth client metadata URL/,
  );
  provider.clientMetadataDocument = () => document;
  provider.discovery = undefined;
  assert.equal(await authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }), "REDIRECT");
  assert.equal(paths.includes("/register"), false);
  assert.equal(provider.authorizationUrl?.searchParams.get("client_id"), document.url);
  assert.equal(provider.authorizationUrl?.searchParams.get("redirect_uri"), document.redirectUrl);
  assert.equal(provider.client, undefined);
});

test("an OAuth error other than invalid_grant keeps the stored grant", { timeout: 5_000 }, async () => {
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    if (url.pathname === "/.well-known/oauth-authorization-server") return jsonResponse(authorizationMetadata("https://mcp.example"));
    if (url.pathname === "/token") return jsonResponse({ error: "invalid_scope", access_token: "half", token_type: "Bearer" }, 400);
    return new Response("missing", { status: 404 });
  });
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  provider.tokenSet = { access_token: "keep", refresh_token: "r1", token_type: "Bearer", scope: "read" };
  await assert.rejects(
    authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }),
    (error: unknown) => error instanceof OAuthError && error.code === "invalid_scope",
  );
  assert.equal(provider.tokenSet?.access_token, "keep");
  assert.equal(provider.authorizationUrl, undefined);
});

test("does not send a refresh to an insecure token endpoint", { timeout: 5_000 }, async () => {
  let tokenFetched = false;
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    if (url.pathname === "/token" || url.hostname === "evil.example") {
      tokenFetched = true;
      return jsonResponse({ access_token: "nope", token_type: "Bearer" });
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        ...authorizationMetadata("https://mcp.example"),
        token_endpoint: "http://evil.example/token",
      });
    }
    return new Response("missing", { status: 404 });
  });
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  provider.tokenSet = { access_token: "keep", refresh_token: "r1", token_type: "Bearer" };
  await assert.rejects(
    authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }),
    (error: unknown) => error instanceof OAuthInsecureEndpointError,
  );
  assert.equal(tokenFetched, false);
  assert.equal(provider.tokenSet?.access_token, "keep");
});

test("does not retry the MCP request when refresh fails", { timeout: 10_000 }, async () => {
  let mcpPosts = 0;
  let tokenPosts = 0;
  const bearers: string[] = [];
  const { mcpUrl } = await listen(async (request, response, serverOrigin) => {
    const url = new URL(request.url ?? "/", serverOrigin);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      sendJson(response, { resource: `${serverOrigin}/mcp`, authorization_servers: [serverOrigin] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(response, authorizationMetadata(serverOrigin));
      return;
    }
    if (url.pathname === "/token") {
      tokenPosts += 1;
      await readBody(request);
      sendJson(response, { error: "invalid_grant", access_token: "half-token", token_type: "Bearer" }, 400);
      return;
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      mcpPosts += 1;
      bearers.push(request.headers.authorization ?? "");
      await readBody(request);
      send(response, 401, "Unauthorized", { "www-authenticate": "Bearer" });
      return;
    }
    send(response, 404, "");
  });
  const provider = new McpOAuthProvider({
    serverUrl: mcpUrl,
    redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: { client_name: "test" },
    clientId: "client",
    onRedirect: () => undefined,
  });
  await provider.saveTokens({ access_token: "stale", refresh_token: "r1", token_type: "Bearer" });
  const client = new McpClient({ name: "oauth-test", version: "1.0.0" });
  await assert.rejects(
    client.connect(new StreamableHttpTransport({
      url: mcpUrl,
      authProvider: adaptOAuthProvider(provider),
      openGetStream: false,
    })),
    (error: unknown) => error instanceof McpOAuthAuthorizationRequiredError,
  );
  assert.equal(mcpPosts, 1);
  assert.equal(tokenPosts, 1);
  assert.deepEqual(bearers, ["Bearer stale"]);
  assert.equal(await provider.tokens(), undefined);
});

test("callback pages stay on the loopback listener", { timeout: 10_000 }, async () => {
  const plain = await OAuthCallbackServer.listen();
  try {
    const pending = plain.waitForCallback("s1");
    const response = await fetch(`${plain.redirectUrl}?code=abc&state=s1&iss=https://idp.example`);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "Authorization complete. You may close this window.");
    assert.deepEqual(await pending, { code: "abc", state: "s1", iss: "https://idp.example" });
  } finally {
    await plain.close();
  }

  const routed = await OAuthCallbackServer.listen({ extraPaths: ["/callback/server-id"] });
  try {
    const origin = new URL(routed.redirectUrl).origin;
    const mixedUp = routed.waitForCallback("s1", "/callback/server-id");
    mixedUp.catch(() => undefined);
    const wrong = await fetch(`${origin}/callback?code=abc&state=s1`);
    assert.equal(wrong.status, 400);
    await assert.rejects(mixedUp, /arrived on another redirect URI/);
    const pending = routed.waitForCallback("s2", "/callback/server-id");
    const right = await fetch(`${origin}/callback/server-id?code=abc&state=s2`);
    assert.equal(right.status, 200);
    assert.equal((await pending).code, "abc");
  } finally {
    await routed.close();
  }

  const pages: OAuthCallbackPage[] = [];
  const rendered = await OAuthCallbackServer.listen({
    renderPage: (page) => {
      pages.push(page);
      return page.ok ? "<p>ok</p>" : `<p>${page.message}</p>`;
    },
  });
  try {
    const denied = rendered.waitForCallback("s1");
    denied.catch(() => undefined);
    const failure = await fetch(`${rendered.redirectUrl}?error=access_denied&error_description=Denied&state=s1`);
    assert.equal(failure.headers.get("content-type"), "text/html; charset=utf-8");
    await assert.rejects(denied, /Denied/);
    assert.deepEqual(pages.at(-1), {
      ok: false,
      message: "Authorization failed. You may close this window.",
      details: "Denied",
    });
    const pending = rendered.waitForCallback("s2");
    const success = await fetch(`${rendered.redirectUrl}?code=abc&state=s2`);
    assert.equal(await success.text(), "<p>ok</p>");
    assert.equal((await pending).code, "abc");
  } finally {
    await rendered.close();
  }
});


test("does not send an old grant to a newly advertised issuer without metadata", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "old-client", client_secret: "old-secret" };
  provider.tokenSet = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
  provider.discovery = { authorizationServerUrl: "https://old.example", authorizationServerMetadata: authorizationMetadata("https://old.example") };
  const posts: { url: string; body: string }[] = [];
  await assert.rejects(authorizeMcp(provider, {
    serverUrl: "https://mcp.example/mcp",
    fetch: strictFetch(async (input, init) => {
      const url = asUrl(input);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: ["https://new.example"] });
      }
      if (init?.method === "POST") {
        posts.push({ url: url.href, body: String(init.body) });
        return jsonResponse({ client_id: "new-client" });
      }
      return new Response(null, { status: 404 });
    }),
  }), /PKCE S256/);
  assert.equal(posts.some((post) => post.url.endsWith("/token")), false);
  assert.equal(JSON.stringify(posts).includes("old-secret"), false);
  assert.equal(provider.tokenSet, undefined);
});

test("metadata override compares its issuer to the stored grant before refreshing", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "old-client", client_secret: "old-secret" };
  provider.tokenSet = { access_token: "old-access", refresh_token: "old-refresh", token_type: "Bearer" };
  provider.discovery = { authorizationServerUrl: "https://old.example", authorizationServerMetadata: authorizationMetadata("https://old.example") };
  const posts: string[] = [];
  assert.equal(await authorizeMcp(provider, {
    serverUrl: "https://mcp.example/mcp",
    authorizationServerMetadataUrl: new URL("https://mcp.example/configured-metadata"),
    fetch: strictFetch(async (input, init) => {
      const url = asUrl(input);
      if (url.pathname === "/configured-metadata") return jsonResponse(authorizationMetadata("https://new.example", { registration_endpoint: "https://new.example/register" }));
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
      posts.push(String(init?.body));
      if (url.pathname === "/register") return jsonResponse({ client_id: "new-client" });
      throw new Error("old refresh grant must not be sent");
    }),
  }), "REDIRECT");
  assert.equal(JSON.stringify(posts).includes("old-secret"), false);
  assert.equal(provider.discovery?.authorizationServerMetadata?.issuer, "https://new.example");
  assert.equal(provider.authorizationUrl?.searchParams.get("client_id"), "new-client");
});

test("configured client secrets cannot cross an authorization-server issuer", async () => {
  const provider = new McpOAuthProvider({
    serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/callback",
    clientMetadata: {}, clientId: "static-client", clientSecret: "static-secret", onRedirect: () => undefined,
  });
  await provider.saveDiscoveryState({ authorizationServerUrl: "https://old.example", authorizationServerMetadata: authorizationMetadata("https://old.example") });
  await provider.saveTokens({ access_token: "access", refresh_token: "refresh", token_type: "Bearer" });
  let posts = 0;
  await assert.rejects(authorizeMcp(provider, {
    serverUrl: "https://mcp.example/mcp",
    fetch: strictFetch(async (input, init) => {
      if (init?.method === "POST") posts += 1;
      if (asUrl(input).pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: ["https://new.example"] });
      }
      return jsonResponse(authorizationMetadata("https://new.example"));
    }),
  }), /client secret belongs to another/);
  assert.equal(posts, 0);
});

test("access-token headers omit expired grants and reject another MCP server URL", async () => {
  const provider = new McpOAuthProvider({ serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/callback", clientMetadata: {}, onRedirect: () => undefined });
  await provider.saveTokens({ access_token: "expired", refresh_token: "keep-refresh", token_type: "Bearer", expires_in: 0 });
  const auth = adaptOAuthProvider(provider);
  assert.equal(await auth.token(new URL("https://mcp.example/mcp")), undefined);
  assert.equal((await provider.tokens())?.refresh_token, "keep-refresh");
  await assert.rejects(auth.token(new URL("https://other.example/mcp")), /another MCP server URL/);
  let fetched = false;
  await assert.rejects(authorizeMcp(provider, { serverUrl: "https://other.example/mcp", fetch: async () => { fetched = true; return jsonResponse({}); } }), /another MCP server URL/);
  assert.equal(fetched, false);
});

test("OAuth state writes recover after store failure and serialize across providers", async () => {
  let value: import("@amazme/mcp/oauth").McpOAuthState | undefined;
  let fail = true;
  const store = {
    load: async () => structuredClone(value),
    save: async (next: import("@amazme/mcp/oauth").McpOAuthState) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (fail) { fail = false; throw new Error("disk unavailable"); }
      value = structuredClone(next);
    },
  };
  const options = { serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/callback", clientMetadata: {}, onRedirect: () => undefined, store };
  const first = new McpOAuthProvider(options);
  const second = new McpOAuthProvider(options);
  await assert.rejects(first.saveTokens({ access_token: "lost", token_type: "Bearer" }), /disk unavailable/);
  await Promise.all([
    first.saveTokens({ access_token: "kept", token_type: "Bearer" }),
    second.saveClientInformation({ client_id: "client" }),
  ]);
  assert.equal((await first.tokens())?.access_token, "kept");
  assert.equal((await second.clientInformation())?.client_id, "client");
  const tokens = await first.tokens();
  tokens!.access_token = "mutated";
  assert.equal((await first.tokens())?.access_token, "kept");
});

test("authorization redemption uses its PKCE issuer, redirect and scope snapshot", async () => {
  let redirected: URL | undefined;
  const provider = new McpOAuthProvider({
    serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/fallback", clientMetadata: {},
    clientMetadataDocument: () => ({ url: "https://client.example/metadata", redirectUrl: "http://127.0.0.1/pinned" }),
    onRedirect: (url) => { redirected = url; },
  });
  const posted: URLSearchParams[] = [];
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: ["https://idp.example"] });
    if (url.pathname.startsWith("/.well-known")) return jsonResponse(authorizationMetadata("https://idp.example"));
    assert.equal(url.href, "https://idp.example/token");
    posted.push(new URLSearchParams(formBody(init?.body)));
    return jsonResponse({ access_token: "new", token_type: "Bearer" });
  });
  assert.equal(await authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", scope: "requested:scope", fetch: fetchImpl }), "REDIRECT");
  assert.ok(redirected);
  await provider.saveDiscoveryState({ authorizationServerUrl: "https://other.example", authorizationServerMetadata: authorizationMetadata("https://other.example") });
  await assert.rejects(authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", authorizationCode: "code", state: "wrong", fetch: fetchImpl }), /callback state/);
  const state = redirected.searchParams.get("state")!;
  assert.equal(await authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", authorizationCode: "code", state, iss: "https://idp.example", fetch: fetchImpl }), "AUTHORIZED");
  assert.equal(posted[0]?.get("redirect_uri"), "http://127.0.0.1/pinned");
  assert.equal(posted[0]?.get("client_id"), "https://client.example/metadata");
  assert.equal((await provider.tokens())?.scope, "requested:scope");
  assert.equal(await provider.authorizationState(), undefined);
  await assert.rejects(provider.codeVerifier(), /No OAuth PKCE/);
});

test("OAuth abort stops injected discovery and does not persist late authorization", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  const controller = new AbortController();
  let release: ((response: Response) => void) | undefined;
  const operation = authorizeMcp(provider, {
    serverUrl: "https://mcp.example/mcp", signal: controller.signal,
    fetch: async (_input, init) => {
      assert.equal(init?.signal, controller.signal);
      return new Promise<Response>((resolve) => { release = resolve; });
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("stop-discovery"));
  await assert.rejects(operation, /stop-discovery/);
  release?.(jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: ["https://idp.example"] }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(provider.discovery, undefined);
  assert.equal(provider.client, undefined);
  assert.equal(provider.authorizationUrl, undefined);
});

test("cancelling one OAuth refresh waiter keeps siblings and cancellation of all aborts refresh", async () => {
  for (const cancelAll of [false, true]) {
    const provider = new TestOAuthProvider("http://127.0.0.1/callback");
    provider.client = { client_id: "client" };
    provider.tokenSet = { access_token: "old", refresh_token: "refresh", token_type: "Bearer" };
    let tokenSignal: AbortSignal | undefined;
    let release!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const fetchImpl = strictFetch(async (input, init) => {
      const url = asUrl(input);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
      if (url.pathname.startsWith("/.well-known")) return jsonResponse(authorizationMetadata("https://mcp.example"));
      tokenSignal = init?.signal ?? undefined;
      const response = new Promise<Response>((resolve) => { release = resolve; });
      started();
      return response;
    });
    const first = new AbortController();
    const second = new AbortController();
    const context = { response: new Response(null, { status: 401 }), serverUrl: new URL("https://mcp.example/mcp"), fetch: fetchImpl, token: "old" };
    const firstPending = challenge(adaptOAuthProvider(provider), { ...context, signal: first.signal });
    const secondPending = challenge(adaptOAuthProvider(provider), { ...context, signal: second.signal });
    firstPending.catch(() => undefined);
    secondPending.catch(() => undefined);
    await ready;
    first.abort(new Error("first-stopped"));
    await assert.rejects(firstPending, /first-stopped/);
    assert.equal(tokenSignal?.aborted, false);
    if (cancelAll) {
      second.abort(new Error("second-stopped"));
      await assert.rejects(secondPending, /second-stopped/);
      assert.equal(tokenSignal?.aborted, true);
      release(jsonResponse({ access_token: "late", token_type: "Bearer" }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(provider.tokenSet?.access_token, "old");
    } else {
      release(jsonResponse({ access_token: "fresh", token_type: "Bearer" }));
      await secondPending;
      assert.equal(provider.tokenSet?.access_token, "fresh");
    }
  }
});

test("OAuth token basic auth encodes credentials and errors never include echoed secrets", async () => {
  const metadata = authorizationMetadata("https://idp.example", { token_endpoint_auth_methods_supported: ["client_secret_basic"] });
  const credentials = { client_id: "client: a", client_secret: "secret:+ b" };
  const seen: string[] = [];
  const fetchImpl = strictFetch(async (_input, init) => {
    assert.equal(init?.redirect, "error");
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    const params = formBody(init?.body);
    assert.equal(params.get("client_secret"), null);
    return jsonResponse({ error: "invalid_scope", error_description: `${credentials.client_secret} ${params.get("code")} ${params.get("code_verifier")} ${new Headers(init?.headers).get("authorization")}`, access_token: "half-token" }, 400);
  });
  await assert.rejects(exchangeAuthorizationCode("https://idp.example", {
    metadata, clientInformation: credentials, code: "secret-code", codeVerifier: "secret-verifier", redirectUrl: "http://127.0.0.1/callback", fetch: fetchImpl,
  }), (error: unknown) => error instanceof OAuthError && !error.message.includes("secret") && !error.message.includes("Basic") && error.code === "invalid_scope");
  assert.equal(Buffer.from(seen[0]!.slice(6), "base64").toString(), "client%3A+a:secret%3A%2B+b");
  await assert.rejects(refreshAuthorization("https://idp.example", {
    metadata, clientInformation: credentials, refreshToken: "private-refresh", fetch: async () => new Response("private-refresh secret:+ b", { status: 500 }),
  }), (error: unknown) => error instanceof OAuthError && !error.message.includes("private-refresh"));
  await assert.rejects(registerClient("https://idp.example", {
    metadata: { ...metadata, registration_endpoint: "https://idp.example/register" }, clientMetadata: { redirect_uris: ["http://127.0.0.1/callback"] },
    fetch: async () => new Response("server-private-token", { status: 500 }),
  }), (error: unknown) => error instanceof Error && !error.message.includes("server-private-token"));
});

test("authorization rejects missing PKCE support and insecure non-HTTP loopback endpoints", async () => {
  const common = { clientInformation: { client_id: "client" }, redirectUrl: "http://127.0.0.1/callback" };
  await assert.rejects(startAuthorization("https://idp.example", { ...common, metadata: { ...authorizationMetadata("https://idp.example"), code_challenge_methods_supported: undefined } }), /PKCE S256/);
  await assert.rejects(startAuthorization("https://idp.example", { ...common, metadata: authorizationMetadata("https://idp.example", { authorization_endpoint: "http://evil.example/authorize" }) }), OAuthInsecureEndpointError);
  await assert.rejects(refreshAuthorization("http://127.0.0.1", { clientInformation: { client_id: "client" }, refreshToken: "private", metadata: authorizationMetadata("http://127.0.0.1", { token_endpoint: "ftp://127.0.0.1/token" }) }), OAuthInsecureEndpointError);
});

test("callback waits cancel and validate issuer before displaying OAuth errors", { timeout: 5_000 }, async () => {
  const pages: OAuthCallbackPage[] = [];
  const server = await OAuthCallbackServer.listen({ renderPage: (page) => { pages.push(page); return "safe"; } });
  try {
    const controller = new AbortController();
    const cancelled = server.waitForCallback("cancelled", { signal: controller.signal });
    controller.abort(new Error("cancel-callback"));
    await assert.rejects(cancelled, /cancel-callback/);
    assert.equal((await fetch(`${server.redirectUrl}?code=late&state=cancelled`)).status, 400);
    const mixedUp = server.waitForCallback("mixed", { issuer: "https://idp.example", requireIss: true });
    mixedUp.catch(() => undefined);
    const response = await fetch(`${server.redirectUrl}?state=mixed&error=access_denied&error_description=attacker-text&iss=https://other.example`);
    assert.equal(response.status, 400);
    await assert.rejects(mixedUp, OAuthIssuerMismatchError);
    assert.equal(JSON.stringify(pages).includes("attacker-text"), false);
  } finally {
    await server.close();
  }
  await assert.rejects(server.waitForCallback("after-close"), /closed/);
  await server.close();
});


test("Bearer challenges parse across multiple schemes without reading quoted realm parameters", () => {
  const parsed = parseWwwAuthenticate(String.raw`Basic realm="scope=fake", Bearer realm="a, scope=wrong", error="insufficient_scope", scope="read write", error_description="say \"no\", retry", resource_metadata="https://mcp.example/metadata"`);
  assert.equal(parsed.scope, "read write");
  assert.equal(parsed.error, "insufficient_scope");
  assert.equal(parsed.resourceMetadataUrl?.href, "https://mcp.example/metadata");
  assert.equal(parsed.errorDescription, 'say "no", retry');
});

test("rejected authorization codes are not retried or stripped of their original OAuth error", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  provider.verifier = "verifier";
  provider.discovery = { authorizationServerUrl: "https://idp.example", authorizationServerMetadata: authorizationMetadata("https://idp.example") };
  provider.saveAuthorizationState({ serverUrl: "https://mcp.example/mcp", discovery: { ...provider.discovery, authorizationServerMetadata: provider.discovery.authorizationServerMetadata! }, clientInformation: provider.client, redirectUrl: provider.redirectUrl, codeVerifier: provider.verifier, state: "expected-state" });
  let posts = 0;
  await assert.rejects(authorizeMcp(provider, {
    serverUrl: "https://mcp.example/mcp", authorizationCode: "single-use-code", state: "expected-state",
    fetch: async () => { posts += 1; return jsonResponse({ error: "invalid_client" }, 400); },
  }), (error: unknown) => error instanceof OAuthError && error.code === "invalid_client");
  assert.equal(posts, 1);
});

test("configured secret issuer binding survives grant invalidation", async () => {
  const provider = new McpOAuthProvider({ serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/callback", clientMetadata: {}, clientId: "client", clientSecret: "private", onRedirect: () => undefined });
  await provider.saveDiscoveryState({ authorizationServerUrl: "https://old.example", authorizationServerMetadata: authorizationMetadata("https://old.example") });
  await provider.invalidateCredentials("all");
  await assert.rejects(provider.assertClientIssuer("https://new.example"), /client secret belongs to another/);
});


test("OAuth credential POST redirects are refused without forwarding secrets", { timeout: 5_000 }, async () => {
  let received = 0;
  const target = await listen(async (request, response) => { received += 1; await readBody(request); sendJson(response, { access_token: "leaked", token_type: "Bearer" }); });
  const source = await listen(async (request, response) => { await readBody(request); response.writeHead(307, { location: `${target.origin}/steal` }).end(); });
  await assert.rejects(refreshAuthorization(source.origin, { clientInformation: { client_id: "client", client_secret: "private-secret" }, refreshToken: "private-refresh" }));
  assert.equal(received, 0);
});

test("OAuth token parsing rejects invalid header tokens, token kinds and expiry types", async () => {
  const provider = new McpOAuthProvider({ serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/callback", clientMetadata: {}, onRedirect: () => undefined });
  await assert.rejects(provider.saveTokens({ access_token: "private\r\ntoken", token_type: "Bearer" }), (error: unknown) => error instanceof Error && !error.message.includes("private"));
  await assert.rejects(provider.saveTokens({ access_token: "opaque", token_type: "DPoP" }), /Unsupported OAuth token_type/);
  await assert.rejects(refreshAuthorization("https://idp.example", { clientInformation: { client_id: "client" }, refreshToken: "refresh", fetch: async () => jsonResponse({ access_token: "valid", token_type: "Bearer", expires_in: true }) }), /Invalid expires_in/);
  await assert.rejects(provider.saveTokens({ access_token: "opaque", token_type: "Bearer", expires_in: -1 }), /Invalid expires_in/);
  assert.equal(await provider.tokens(), undefined);
});


test("providers sharing one OAuth store share rotating refresh-token coordination", async () => {
  const store = new MemoryOAuthStateStore();
  const options = { serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/callback", clientMetadata: {}, clientId: "client", store, onRedirect: () => undefined };
  const first = new McpOAuthProvider(options);
  const second = new McpOAuthProvider(options);
  await first.saveTokens({ access_token: "old", refresh_token: "rotate-once", token_type: "Bearer" });
  let refreshes = 0;
  const fetchImpl = strictFetch(async (input, init) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    if (url.pathname.startsWith("/.well-known")) return jsonResponse(authorizationMetadata("https://mcp.example"));
    refreshes += 1;
    assert.equal(formBody(init?.body).get("refresh_token"), "rotate-once");
    await new Promise<void>((resolve) => setImmediate(resolve));
    return jsonResponse({ access_token: "fresh", refresh_token: "rotated", token_type: "Bearer" });
  });
  const context = { response: new Response(null, { status: 401 }), serverUrl: new URL(options.serverUrl), fetch: fetchImpl, token: "old" };
  await Promise.all([challenge(adaptOAuthProvider(first), context), challenge(adaptOAuthProvider(second), context)]);
  assert.equal(refreshes, 1);
  assert.equal((await second.tokens())?.refresh_token, "rotated");
});

test("step-up preserves previously requested scopes even when the grant narrowed them", async () => {
  let authorizationUrl: URL | undefined;
  const provider = new McpOAuthProvider({ serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/callback", clientMetadata: {}, clientId: "client", onRedirect: (url) => { authorizationUrl = url; } });
  await provider.saveAuthorizationState({ serverUrl: "https://mcp.example/mcp", discovery: { authorizationServerUrl: "https://mcp.example", authorizationServerMetadata: authorizationMetadata("https://mcp.example") }, clientInformation: { client_id: "client" }, redirectUrl: "http://127.0.0.1/callback", codeVerifier: "verifier", state: "scope-state", scope: "read old-requested" });
  await provider.saveTokens({ access_token: "grant", token_type: "Bearer", scope: "read" });
  const fetchImpl = strictFetch(async (input) => {
    if (asUrl(input).pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    return jsonResponse(authorizationMetadata("https://mcp.example"));
  });
  await assert.rejects(challenge(adaptOAuthProvider(provider), { response: new Response(null, { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="write"' } }), serverUrl: new URL("https://mcp.example/mcp"), fetch: fetchImpl, token: "grant" }), McpOAuthAuthorizationRequiredError);
  assert.equal(authorizationUrl?.searchParams.get("scope"), "read old-requested write");
});


test("a concurrent scope challenge waits for refresh then starts a scope upgrade", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  provider.tokenSet = { access_token: "old", refresh_token: "rotate", token_type: "Bearer", scope: "read" };
  let release!: (response: Response) => void;
  let started!: () => void;
  const refreshing = new Promise<void>((resolve) => { started = resolve; });
  let tokenPosts = 0;
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    if (url.pathname.startsWith("/.well-known")) return jsonResponse(authorizationMetadata("https://mcp.example"));
    tokenPosts += 1;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    started();
    return response;
  });
  const auth = adaptOAuthProvider(provider);
  const context = { response: new Response(null, { status: 401 }), serverUrl: new URL("https://mcp.example/mcp"), fetch: fetchImpl, token: "old" };
  const refresh = challenge(auth, context);
  await refreshing;
  const upgrade = challenge(auth, { ...context, response: new Response(null, { status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="write"' } }) });
  upgrade.catch(() => undefined);
  release(jsonResponse({ access_token: "fresh", refresh_token: "rotated", token_type: "Bearer", scope: "read" }));
  await refresh;
  await assert.rejects(upgrade, McpOAuthAuthorizationRequiredError);
  assert.equal(tokenPosts, 1);
  assert.equal(provider.authorizationUrl?.searchParams.get("scope"), "read write");
});

test("different concurrent scope challenges accumulate both required scope sets", async () => {
  const provider = new McpOAuthProvider({ serverUrl: "https://mcp.example/mcp", redirectUrl: "http://127.0.0.1/callback", clientMetadata: {}, clientId: "client", onRedirect: () => undefined });
  await provider.saveTokens({ access_token: "grant", token_type: "Bearer", scope: "read" });
  const fetchImpl = strictFetch(async (input) => {
    if (asUrl(input).pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    return jsonResponse(authorizationMetadata("https://mcp.example"));
  });
  const auth = adaptOAuthProvider(provider);
  const context = { serverUrl: new URL("https://mcp.example/mcp"), fetch: fetchImpl, token: "grant" };
  const outcomes = await Promise.allSettled(["write", "admin"].map((scope) => challenge(auth, { ...context, response: new Response(null, { status: 403, headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"` } }) })));
  for (const outcome of outcomes) assert.equal(outcome.status, "rejected");
  assert.equal((await provider.authorizationState())?.scope, "read write admin");
});


test("code redemption requires the exact pending authorization record", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  provider.verifier = "old-verifier";
  provider.discovery = { authorizationServerUrl: "https://idp.example", authorizationServerMetadata: authorizationMetadata("https://idp.example") };
  let fetched = false;
  await assert.rejects(authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", authorizationCode: "code", fetch: async () => { fetched = true; return jsonResponse({ access_token: "token", token_type: "Bearer" }); } }), /No complete pending OAuth authorization/);
  assert.equal(fetched, false);
});


test("empty OAuth state cannot start or redeem an authorization", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "client" };
  provider.state = () => "";
  const fetchImpl = strictFetch(async (input) => {
    if (asUrl(input).pathname.startsWith("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
    return jsonResponse(authorizationMetadata("https://mcp.example"));
  });
  await assert.rejects(authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", fetch: fetchImpl }), /OAuth state must not be empty/);
  assert.equal(provider.authorizationUrl, undefined);
  provider.authorization = { serverUrl: "https://mcp.example/mcp", discovery: { authorizationServerUrl: "https://mcp.example", authorizationServerMetadata: authorizationMetadata("https://mcp.example") }, clientInformation: { client_id: "client" }, redirectUrl: provider.redirectUrl, codeVerifier: "verifier", state: "" };
  let redeemed = false;
  await assert.rejects(authorizeMcp(provider, { serverUrl: "https://mcp.example/mcp", authorizationCode: "code", state: "", fetch: async () => { redeemed = true; return jsonResponse({ access_token: "token", token_type: "Bearer" }); } }), /No complete pending OAuth authorization/);
  assert.equal(redeemed, false);
});


test("different resource-metadata challenges are discovered after an in-flight refresh", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.client = { client_id: "old-client" };
  provider.tokenSet = { access_token: "old", refresh_token: "refresh", token_type: "Bearer" };
  let release!: (response: Response) => void;
  let started!: () => void;
  const refreshing = new Promise<void>((resolve) => { started = resolve; });
  const documents: string[] = [];
  let tokenPosts = 0;
  const fetchImpl = strictFetch(async (input) => {
    const url = asUrl(input);
    if (url.pathname.startsWith("/metadata-")) {
      documents.push(url.pathname);
      return jsonResponse({ resource: "https://mcp.example/mcp", authorization_servers: [url.pathname === "/metadata-a" ? "https://old.example" : "https://new.example"] });
    }
    if (url.pathname.startsWith("/.well-known")) return jsonResponse(authorizationMetadata(url.origin, { registration_endpoint: `${url.origin}/register` }));
    if (url.pathname === "/register") return jsonResponse({ client_id: "new-client" });
    tokenPosts += 1;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    started();
    return response;
  });
  const auth = adaptOAuthProvider(provider);
  const context = { serverUrl: new URL("https://mcp.example/mcp"), fetch: fetchImpl, token: "old" };
  const response = (document: string) => new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="https://mcp.example/${document}"` } });
  const first = challenge(auth, { ...context, response: response("metadata-a") });
  await refreshing;
  const second = challenge(auth, { ...context, response: response("metadata-b") });
  second.catch(() => undefined);
  release(jsonResponse({ access_token: "fresh", refresh_token: "rotated", token_type: "Bearer" }));
  await first;
  await assert.rejects(second, McpOAuthAuthorizationRequiredError);
  assert.deepEqual(documents, ["/metadata-a", "/metadata-b"]);
  assert.equal(tokenPosts, 1);
  assert.equal(provider.authorizationUrl?.origin, "https://new.example");
});

test("pending authorization snapshots are bound to their MCP resource even for custom providers", async () => {
  const provider = new TestOAuthProvider("http://127.0.0.1/callback");
  provider.authorization = { serverUrl: "https://mcp.example/original", discovery: { authorizationServerUrl: "https://idp.example", authorizationServerMetadata: authorizationMetadata("https://idp.example") }, clientInformation: { client_id: "client" }, redirectUrl: provider.redirectUrl, codeVerifier: "verifier", state: "state" };
  let fetched = false;
  await assert.rejects(authorizeMcp(provider, { serverUrl: "https://mcp.example/another", authorizationCode: "code", state: "state", fetch: async () => { fetched = true; return jsonResponse({ access_token: "token", token_type: "Bearer" }); } }), /another MCP server URL/);
  assert.equal(fetched, false);
});
