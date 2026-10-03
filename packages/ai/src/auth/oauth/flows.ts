import type { LoginInteraction, LoginResult, OAuthAuth, OAuthLoginHandback } from "../../auth.ts";
import type { OAuthCredential } from "../../types.ts";
import { startCallbackServer } from "./callback-server.ts";
import { pollDeviceCode } from "./device-code.ts";
import { accountIdFromJwt, credential, expiresIn, httpsUrl, postForm, readJson, signalOf } from "./http.ts";
import { generatePkce, randomState } from "./pkce.ts";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function handback(interaction: LoginInteraction, value: OAuthLoginHandback): OAuthLoginHandback {
  interaction.onHandback?.(value);
  return value;
}

function method(interaction: LoginInteraction, fallback: "pkce" | "device_code"): "pkce" | "device_code" {
  return interaction.method ?? fallback;
}

async function exchangeForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await postForm(fetchImpl, url, fields, signal);
  const body = await readJson(response);
  if (!response.ok) throw new Error(`OAuth token request failed (${response.status})`);
  return body;
}

export function chatgptOAuth(fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  return {
    name: "OpenAI (ChatGPT subscription)",
    isSubscription: true,
    async login(interaction) {
      const deviceId = interaction.deviceId;
      if (!deviceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
        throw new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation");
      }
      const signal = signalOf(interaction);
      const { verifier, challenge } = await generatePkce();
      const state = randomState();
      const port = interaction.callbackPort ?? 1455;
      const callback = await startCallbackServer({ port, path: "/auth/callback", host: "127.0.0.1", signal, timeoutMs: LOGIN_TIMEOUT_MS });
      const redirect = port === 1455 ? "http://127.0.0.1:1455/auth/callback" : callback.redirectUri;
      try {
        const url = new URL("https://auth.openai.com/api/accounts/authorize");
        url.search = new URLSearchParams({
          client_id: "dynamic_agent_client",
          response_type: "code",
          redirect_uri: redirect,
          resource: "https://api.openai.com/v1",
          scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          nonce: randomState(),
          ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
        }).toString();
        const shown = handback(interaction, { auth_url: url.toString() });
        const landed = await callback.wait();
        if (landed.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
        const code = landed.searchParams.get("code");
        const clientId = landed.searchParams.get("client_id")?.trim();
        if (!code || !clientId) throw new Error("OpenAI OAuth registration callback did not contain a code and issued client ID");
        const token = await exchangeForm(fetchImpl, "https://auth.openai.com/api/accounts/oauth/token", {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: "https://api.openai.com/v1",
        }, signal);
        return { ...shown, credential: openaiCredential(token, clientId) };
      } finally {
        callback.close();
      }
    },
    async refresh(current, signal) {
      if (!current.clientId) throw new Error("Stored OpenAI OAuth credential does not contain an issued client ID");
      const token = await exchangeForm(fetchImpl, "https://auth.openai.com/api/accounts/oauth/token", {
        grant_type: "refresh_token",
        client_id: current.clientId,
        refresh_token: current.refresh,
        resource: "https://api.openai.com/v1",
      }, signal);
      return openaiCredential(token, current.clientId);
    },
    async toAuth(current) {
      return { apiKey: current.access };
    },
  };
}

function openaiCredential(token: Record<string, unknown>, clientId: string): OAuthCredential {
  const access = required(token, "access_token");
  const refresh = required(token, "refresh_token");
  const scope = required(token, "scope");
  if (!scope.split(/\s+/).includes("chatgpt.tokens.use.direct")) {
    throw new Error("OpenAI OAuth grant did not include chatgpt.tokens.use.direct");
  }
  if (typeof token.id_token !== "string" || token.id_token.length === 0) throw new Error("OpenAI OAuth token response did not contain an ID token");
  return credential(access, refresh, expiresIn(token.expires_in), { clientId });
}

export function codexOAuth(fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  return {
    name: "OpenAI (ChatGPT Plus/Pro)",
    isSubscription: true,
    async login(interaction): Promise<LoginResult> {
      const chosen = method(interaction, "device_code");
      if (chosen === "pkce") return codexPkce(interaction, fetchImpl);
      return codexDevice(interaction, fetchImpl);
    },
    async refresh(current, signal) {
      const token = await exchangeForm(fetchImpl, "https://auth.openai.com/oauth/token", {
        grant_type: "refresh_token",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        refresh_token: current.refresh,
      }, signal);
      return codexCredential(token);
    },
    async toAuth(current) {
      return {
        apiKey: current.access,
        ...(current.accountId ? { env: { CHATGPT_ACCOUNT_ID: current.accountId } } : {}),
      };
    },
  };
}

async function codexDevice(interaction: LoginInteraction, fetchImpl: typeof fetch): Promise<LoginResult> {
  const signal = signalOf(interaction);
  const started = await fetchImpl("https://auth.openai.com/api/accounts/deviceauth/usercode", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }),
    signal,
  });
  const device = await readJson(started);
  if (!started.ok) throw new Error(`OpenAI Codex device code request failed (${started.status})`);
  const userCode = required(device, "user_code");
  const deviceAuthId = required(device, "device_auth_id");
  const shown = handback(interaction, {
    device_code: {
      user_code: userCode,
      verification_uri: "https://auth.openai.com/codex/device",
      interval: typeof device.interval === "number" ? device.interval : undefined,
      expires_in: 15 * 60,
    },
  });
  const polled = await pollDeviceCode({
    intervalSeconds: typeof device.interval === "number" ? device.interval : 5,
    expiresInSeconds: 15 * 60,
    signal,
    poll: async () => {
      const response = await fetchImpl("https://auth.openai.com/api/accounts/deviceauth/token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal,
      });
      if (response.ok) {
        const body = await readJson(response);
        if (typeof body.authorization_code === "string" && typeof body.code_verifier === "string") {
          return { status: "complete", value: { code: body.authorization_code, verifier: body.code_verifier } };
        }
        return { status: "failed", message: "Invalid OpenAI Codex device auth token response" };
      }
      if (response.status === 403 || response.status === 404) return { status: "pending" };
      const body = await readJson(response);
      const error = typeof body.error === "string" ? body.error : "";
      if (error === "deviceauth_authorization_pending") return { status: "pending" };
      if (error === "slow_down") return { status: "slow_down" };
      return { status: "failed", message: `OpenAI Codex device auth failed (${response.status})` };
    },
  });
  const token = await exchangeForm(fetchImpl, "https://auth.openai.com/oauth/token", {
    grant_type: "authorization_code",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    code: polled.code,
    code_verifier: polled.verifier,
    redirect_uri: "https://auth.openai.com/deviceauth/callback",
  }, signal);
  return { ...shown, credential: codexCredential(token) };
}

async function codexPkce(interaction: LoginInteraction, fetchImpl: typeof fetch): Promise<LoginResult> {
  const signal = signalOf(interaction);
  const { verifier, challenge } = await generatePkce();
  const state = randomState();
  const port = interaction.callbackPort ?? 1455;
  const callback = await startCallbackServer({
    port,
    path: "/auth/callback",
    host: "127.0.0.1",
    redirectHost: "localhost",
    state,
    signal,
    timeoutMs: LOGIN_TIMEOUT_MS,
  });
  const redirect = port === 1455 ? "http://localhost:1455/auth/callback" : callback.redirectUri;
  try {
    const url = new URL("https://auth.openai.com/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirect_uri: redirect,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    const shown = handback(interaction, { auth_url: url.toString() });
    const landed = await callback.wait();
    const code = landed.searchParams.get("code");
    if (!code) throw new Error("Missing authorization code");
    const token = await exchangeForm(fetchImpl, "https://auth.openai.com/oauth/token", {
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
    }, signal);
    return { ...shown, credential: codexCredential(token) };
  } finally {
    callback.close();
  }
}

function codexCredential(token: Record<string, unknown>): OAuthCredential {
  const access = required(token, "access_token");
  const refresh = required(token, "refresh_token");
  const accountId = accountIdFromJwt(access);
  return credential(access, refresh, expiresIn(token.expires_in), ...(accountId ? [{ accountId }] : []));
}

export function anthropicOAuth(fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  const clientId = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
  const scope = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
  return {
    name: "Anthropic (Claude Pro/Max)",
    isSubscription: true,
    async login(interaction) {
      const signal = signalOf(interaction);
      const { verifier, challenge } = await generatePkce();
      const state = randomState();
      const port = interaction.callbackPort ?? 53692;
      const callback = await startCallbackServer({
        port,
        path: "/callback",
        host: "127.0.0.1",
        redirectHost: port === 53692 ? "localhost" : "127.0.0.1",
        state,
        signal,
        timeoutMs: LOGIN_TIMEOUT_MS,
      });
      try {
        const url = new URL("https://claude.ai/oauth/authorize");
        url.search = new URLSearchParams({
          client_id: clientId,
          response_type: "code",
          redirect_uri: callback.redirectUri,
          scope,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString();
        const shown = handback(interaction, { auth_url: url.toString() });
        const landed = await callback.wait();
        const code = landed.searchParams.get("code");
        if (!code) throw new Error("Missing authorization code");
        const token = await exchangeForm(fetchImpl, "https://platform.claude.com/v1/oauth/token", {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: callback.redirectUri,
          state,
        }, signal);
        return { ...shown, credential: pair(token) };
      } finally {
        callback.close();
      }
    },
    async refresh(current, signal) {
      const token = await exchangeForm(fetchImpl, "https://platform.claude.com/v1/oauth/token", {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: current.refresh,
      }, signal);
      return pair(token);
    },
    async toAuth(current) {
      return { apiKey: current.access };
    },
  };
}

export function xaiOAuth(fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  const clientId = "b1a00492-073a-47ea-816f-4c329264a828";
  return {
    name: "xAI (Grok/X subscription)",
    isSubscription: true,
    async login(interaction) {
      const signal = signalOf(interaction);
      const response = await postForm(fetchImpl, "https://auth.x.ai/oauth2/device/code", {
        client_id: clientId,
        scope: "openid profile email offline_access grok-cli:access api:access",
      }, signal);
      const body = await readJson(response);
      if (!response.ok) throw new Error(`xAI device authorization failed (${response.status})`);
      const verification = httpsUrl(body.verification_uri);
      if (!verification) throw new Error("xAI verification URI must be https");
      const userCode = required(body, "user_code");
      const deviceCode = required(body, "device_code");
      const shown = handback(interaction, {
        device_code: {
          user_code: userCode,
          verification_uri: verification,
          ...(typeof body.interval === "number" ? { interval: body.interval } : {}),
          ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
        },
      });
      const token = await pollDeviceCode({
        intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
        ...(typeof body.expires_in === "number" ? { expiresInSeconds: body.expires_in } : {}),
        signal,
        poll: async () => {
          const next = await postForm(fetchImpl, "https://auth.x.ai/oauth2/token", {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: clientId,
            device_code: deviceCode,
          }, signal);
          const parsed = await readJson(next);
          if (next.ok && typeof parsed.access_token === "string") return { status: "complete", value: parsed };
          const error = typeof parsed.error === "string" ? parsed.error : "";
          if (error === "authorization_pending") return { status: "pending" };
          if (error === "slow_down") return { status: "slow_down", ...(typeof parsed.interval === "number" ? { intervalSeconds: parsed.interval } : {}) };
          if (error === "access_denied") return { status: "failed", message: "xAI device authorization was denied" };
          if (error === "expired_token") return { status: "failed", message: "xAI device code expired" };
          return { status: "failed", message: `xAI device token polling failed (${next.status})` };
        },
      });
      return { ...shown, credential: pair(token, typeof token.refresh_token === "string" ? token.refresh_token : "") };
    },
    async refresh(current, signal) {
      const token = await exchangeForm(fetchImpl, "https://auth.x.ai/oauth2/token", {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: current.refresh,
      }, signal);
      const refresh = typeof token.refresh_token === "string" && token.refresh_token.length > 0 ? token.refresh_token : current.refresh;
      return pair(token, refresh);
    },
    async toAuth(current) {
      return { apiKey: current.access };
    },
  };
}

export function githubCopilotOAuth(fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  const clientId = atob("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");
  const headers = {
    "User-Agent": "GitHubCopilotChat/0.35.0",
    Accept: "application/json",
  };
  return {
    name: "GitHub Copilot",
    isSubscription: true,
    async login(interaction) {
      const signal = signalOf(interaction);
      const response = await postForm(fetchImpl, "https://github.com/login/device/code", {
        client_id: clientId,
        scope: "read:user",
      }, signal, headers);
      const body = await readJson(response);
      if (!response.ok) throw new Error(`GitHub device authorization failed (${response.status})`);
      const verification = typeof body.verification_uri === "string" ? body.verification_uri : undefined;
      if (!verification || !verification.startsWith("https://")) throw new Error("Untrusted verification_uri in device code response");
      const userCode = required(body, "user_code");
      const deviceCode = required(body, "device_code");
      const shown = handback(interaction, {
        device_code: {
          user_code: userCode,
          verification_uri: verification,
          ...(typeof body.interval === "number" ? { interval: body.interval } : {}),
          ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
        },
      });
      const githubAccess = await pollDeviceCode({
        intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
        ...(typeof body.expires_in === "number" ? { expiresInSeconds: body.expires_in } : {}),
        waitBeforeFirstPoll: true,
        signal,
        poll: async () => {
          const next = await postForm(fetchImpl, "https://github.com/login/oauth/access_token", {
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }, signal, headers);
          const parsed = await readJson(next);
          if (typeof parsed.access_token === "string") return { status: "complete", value: parsed.access_token };
          const error = typeof parsed.error === "string" ? parsed.error : "";
          if (error === "authorization_pending") return { status: "pending" };
          if (error === "slow_down") return { status: "slow_down", ...(typeof parsed.interval === "number" ? { intervalSeconds: parsed.interval } : {}) };
          return { status: "failed", message: `GitHub device flow failed${error ? `: ${error}` : ""}` };
        },
      });
      return { ...shown, credential: await copilotCredential(fetchImpl, githubAccess, signal) };
    },
    async refresh(current, signal) {
      return copilotCredential(fetchImpl, current.refresh, signal);
    },
    async toAuth(current) {
      return { apiKey: current.access };
    },
  };
}

async function copilotCredential(fetchImpl: typeof fetch, githubAccess: string, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await fetchImpl("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubAccess}`,
      "User-Agent": "GitHubCopilotChat/0.35.0",
      "Editor-Version": "vscode/1.107.0",
      "Editor-Plugin-Version": "copilot-chat/0.35.0",
      "Copilot-Integration-Id": "vscode-chat",
    },
    signal,
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.token !== "string") throw new Error(`GitHub Copilot token request failed (${response.status})`);
  const expiresAt = typeof body.expires_at === "number" ? (body.expires_at < 1e12 ? body.expires_at * 1000 : body.expires_at) : expiresIn(3600);
  return credential(body.token, githubAccess, expiresAt);
}

export function kimiOAuth(fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  const clientId = "17e5f671-d194-4dfb-9706-5516cb48c098";
  const host = "https://auth.kimi.com";
  return {
    name: "Kimi Code (subscription)",
    isSubscription: true,
    async login(interaction) {
      const signal = signalOf(interaction);
      const response = await postForm(fetchImpl, `${host}/api/oauth/device_authorization`, { client_id: clientId }, signal);
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Kimi device authorization failed (${response.status})`);
      const verification = httpsUrl(body.verification_uri_complete) ?? httpsUrl(body.verification_uri);
      if (!verification) throw new Error("Kimi verification URI must be https");
      const userCode = required(body, "user_code");
      const deviceCode = required(body, "device_code");
      const shown = handback(interaction, {
        device_code: {
          user_code: userCode,
          verification_uri: verification,
          ...(typeof body.interval === "number" ? { interval: body.interval } : {}),
          ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
        },
      });
      const token = await pollDeviceCode({
        intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
        expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 15 * 60,
        signal,
        poll: () => kimiPoll(fetchImpl, host, clientId, deviceCode, signal),
      });
      return { ...shown, credential: token };
    },
    async refresh(current, signal) {
      const response = await postForm(fetchImpl, `${host}/api/oauth/token`, {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: current.refresh,
      }, signal);
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Kimi token refresh failed (${response.status})`);
      return pair(body);
    },
    async toAuth(current) {
      return { apiKey: current.access };
    },
  };
}

async function kimiPoll(fetchImpl: typeof fetch, host: string, clientId: string, deviceCode: string, signal: AbortSignal) {
  const response = await postForm(fetchImpl, `${host}/api/oauth/token`, {
    client_id: clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
  }, signal);
  const body = await readJson(response);
  if (response.ok && typeof body.access_token === "string") return { status: "complete" as const, value: pair(body) };
  const error = typeof body.error === "string" ? body.error : "";
  if (error === "authorization_pending") return { status: "pending" as const };
  if (error === "slow_down") return { status: "slow_down" as const };
  return { status: "failed" as const, message: `Kimi device token failed (${response.status})` };
}

export function metaOAuth(fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  const clientId = "1031625952748946";
  return {
    name: "Meta (Muse subscription)",
    isSubscription: true,
    async login(interaction) {
      const signal = signalOf(interaction);
      const response = await postForm(fetchImpl, "https://auth.meta.com/oidc/device/authorization/", { client_id: clientId }, signal);
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Meta device authorization failed (${response.status})`);
      const verification = httpsUrl(body.verification_uri);
      if (!verification) throw new Error("Meta verification URI must be https");
      const userCode = required(body, "user_code");
      const deviceCode = required(body, "device_code");
      const shown = handback(interaction, {
        device_code: {
          user_code: userCode,
          verification_uri: verification,
          ...(typeof body.interval === "number" ? { interval: body.interval } : {}),
          ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
        },
      });
      const identity = await pollDeviceCode({
        intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
        ...(typeof body.expires_in === "number" ? { expiresInSeconds: body.expires_in } : {}),
        signal,
        poll: async () => {
          const next = await postForm(fetchImpl, "https://auth.meta.com/oidc/device/token/", {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
            client_id: clientId,
          }, signal);
          const parsed = await readJson(next);
          if (typeof parsed.access_token === "string") return { status: "complete", value: parsed.access_token };
          const error = typeof parsed.error === "string" ? parsed.error : "";
          if (error === "authorization_pending") return { status: "pending" };
          if (error === "slow_down") return { status: "slow_down" };
          if (error === "access_denied") return { status: "failed", message: "Meta login was denied" };
          return { status: "failed", message: `Meta device token request failed (${next.status})` };
        },
      });
      return { ...shown, credential: await mintMeta(fetchImpl, identity, signal) };
    },
    refresh: (current, signal) => mintMeta(fetchImpl, current.refresh, signal),
    async toAuth(current) {
      return { apiKey: current.access };
    },
  };
}

async function mintMeta(fetchImpl: typeof fetch, identity: string, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await fetchImpl("https://api.meta.ai/muse-code/key", {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${identity}`, "content-type": "application/json", "x-api-version": "1.0.0" },
    body: "{}",
    signal,
  });
  const body = await readJson(response);
  if (response.status === 401 || response.status === 403) throw new Error(`Meta session expired (${response.status})`);
  if (!response.ok || typeof body.api_key !== "string") throw new Error(`Meta API key mint failed (${response.status})`);
  return credential(body.api_key, identity, Date.now() + 24 * 60 * 60 * 1000);
}

export function openRouterOAuth(fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  return {
    name: "OpenRouter OAuth",
    async login(interaction) {
      const signal = signalOf(interaction);
      const { verifier, challenge } = await generatePkce();
      const callback = await startCallbackServer({
        port: interaction.callbackPort ?? 0,
        path: `/oauth/callback/${crypto.randomUUID()}`,
        signal,
        timeoutMs: LOGIN_TIMEOUT_MS,
      });
      try {
        const url = new URL("https://openrouter.ai/auth");
        url.search = new URLSearchParams({
          callback_url: callback.redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString();
        const shown = handback(interaction, { auth_url: url.toString() });
        const landed = await callback.wait();
        const code = landed.searchParams.get("code");
        if (!code) throw new Error("Missing authorization code");
        const response = await fetchImpl("https://openrouter.ai/api/v1/auth/keys", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
          signal,
        });
        const body = await readJson(response);
        if (!response.ok || typeof body.key !== "string" || body.key.length === 0) throw new Error("OpenRouter OAuth response carries no key");
        return { ...shown, credential: credential(body.key, "", Number.MAX_SAFE_INTEGER) };
      } finally {
        callback.close();
      }
    },
    async refresh(current) {
      return current;
    },
    async toAuth(current) {
      return { apiKey: current.access };
    },
  };
}

export function radiusOAuth(gateway = "https://radius.pi.dev", fetchImpl: typeof fetch = globalThis.fetch): OAuthAuth {
  const root = gateway.replace(/\/$/, "");
  return {
    name: "Radius",
    async login(interaction) {
      const chosen = method(interaction, "device_code");
      if (chosen === "pkce") return radiusPkce(interaction, root, fetchImpl);
      return radiusDevice(interaction, root, fetchImpl);
    },
    async refresh(current, signal) {
      const token = await exchangeForm(fetchImpl, `${root}/v1/oauth/token`, {
        grant_type: "refresh_token",
        client_id: "pi-gateway",
        refresh_token: current.refresh,
      }, signal);
      return pair(token);
    },
    async toAuth(current) {
      return { apiKey: current.access };
    },
  };
}

async function radiusDevice(interaction: LoginInteraction, root: string, fetchImpl: typeof fetch): Promise<LoginResult> {
  const signal = signalOf(interaction);
  const response = await postForm(fetchImpl, `${root}/v1/oauth/device`, { client_id: "pi-gateway", scope: "gateway offline_access" }, signal);
  const body = await readJson(response);
  if (!response.ok) throw new Error(`Radius device authorization failed (${response.status})`);
  const verification = httpsUrl(body.verification_uri);
  if (!verification || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new Error("Radius OAuth device authorization response is missing required fields");
  }
  const shown = handback(interaction, {
    device_code: {
      user_code: body.user_code,
      verification_uri: verification,
      ...(typeof body.interval === "number" ? { interval: body.interval } : {}),
      ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
    },
  });
  const token = await pollDeviceCode({
    intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
    ...(typeof body.expires_in === "number" ? { expiresInSeconds: body.expires_in } : {}),
    signal,
    poll: async () => {
      const next = await postForm(fetchImpl, `${root}/v1/oauth/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "pi-gateway",
        device_code: body.device_code as string,
      }, signal);
      const parsed = await readJson(next);
      if (next.ok && typeof parsed.access_token === "string") return { status: "complete", value: parsed };
      const error = typeof parsed.error === "string" ? parsed.error : "";
      if (error === "authorization_pending") return { status: "pending" };
      if (error === "slow_down") return { status: "slow_down" };
      if (error === "access_denied") return { status: "failed", message: "Device authorization was denied" };
      return { status: "failed", message: `Radius device token failed (${next.status})` };
    },
  });
  return { ...shown, credential: pair(token) };
}

async function radiusPkce(interaction: LoginInteraction, root: string, fetchImpl: typeof fetch): Promise<LoginResult> {
  const signal = signalOf(interaction);
  const discoveryResponse = await fetchImpl(`${root}/v1/oauth`, { signal, headers: { accept: "application/json" } });
  const discovery = await readJson(discoveryResponse);
  if (!discoveryResponse.ok) throw new Error(`Radius OAuth discovery failed (${discoveryResponse.status})`);
  const authorization = typeof discovery.authorization_endpoint === "string"
    ? discovery.authorization_endpoint
    : typeof discovery.authorizationEndpoint === "string"
      ? discovery.authorizationEndpoint
      : undefined;
  if (!authorization) throw new Error("Radius OAuth discovery has no authorization endpoint");
  const { verifier, challenge } = await generatePkce();
  const state = randomState();
  const port = interaction.callbackPort ?? 1456;
  const callback = await startCallbackServer({ port, path: "/oauth/callback", state, signal, timeoutMs: LOGIN_TIMEOUT_MS });
  try {
    const url = new URL(authorization);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "pi-gateway",
      redirect_uri: callback.redirectUri,
      scope: "gateway offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    const shown = handback(interaction, { auth_url: url.toString() });
    const landed = await callback.wait();
    const code = landed.searchParams.get("code");
    if (!code) throw new Error("Missing authorization code");
    const token = await exchangeForm(fetchImpl, `${root}/v1/oauth/token`, {
      grant_type: "authorization_code",
      client_id: "pi-gateway",
      redirect_uri: callback.redirectUri,
      code,
      code_verifier: verifier,
    }, signal);
    return { ...shown, credential: pair(token) };
  } finally {
    callback.close();
  }
}

function pair(token: Record<string, unknown>, refresh = required(token, "refresh_token")): OAuthCredential {
  return credential(required(token, "access_token"), refresh, expiresIn(token.expires_in));
}

function required(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`OAuth response is missing ${field}`);
  return value;
}
