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
  type McpFetch,
  McpClient,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  MemoryOAuthStateStore,
  type OAuthCallbackPage,
  OAuthCallbackServer,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  OAuthError,
  OAuthInsecureEndpointError,
  OAuthIssuerMismatchError,
  type OAuthTokens,
  StreamableHttpTransport,
  type UnauthorizedContext,
} from "@amazme/mcp";

class TestOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  client: OAuthClientInformationMixed | undefined;
  tokenSet: OAuthTokens | undefined;
  verifier: string | undefined;
  discovery: OAuthDiscoveryState | undefined;
  authorizationUrl: URL | undefined;
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
    if (kind === "all" || kind === "verifier") this.verifier = undefined;
    if (kind === "all" || kind === "discovery") this.discovery = undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
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
    const { code } = await callbackResult;
    assert.equal(await authorizeMcp(provider, { serverUrl: mcpUrl, authorizationCode: code, fetch }), "AUTHORIZED");

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

test("treats one trailing slash as the same issuer and still refreshes", { timeout: 5_000 }, async () => {
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
    onRedirect: () => {
      throw new Error("refresh should not redirect");
    },
  });
  await provider.saveTokens({ access_token: "old", refresh_token: "keep-me", token_type: "Bearer", expires_in: 30, scope: "read" });
  await provider.saveDiscoveryState({
    authorizationServerUrl: "https://idp.example/",
    authorizationServerMetadata: authorizationMetadata("https://idp.example/"),
  });
  assert.equal(await authorizeMcp(provider, { serverUrl, fetch: fetchImpl }), "AUTHORIZED");
  assert.equal(paths.includes("/register"), false);
  const state = await store.load();
  assert.equal(state?.tokens?.access_token, "renewed");
  assert.equal(state?.tokens?.refresh_token, "keep-me");
  assert.equal(state?.tokens?.scope, "read");
  assert.equal(state?.tokens?.expires_in, undefined);
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
    return authorizeMcp(provider, { serverUrl: `${issuer}/mcp`, authorizationCode: code, iss, fetch: fetchImpl });
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
