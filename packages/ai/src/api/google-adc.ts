import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const EXPIRY_SKEW_MS = 60_000;

/**
 * Read an ADC file at request time and return an access token that is still valid.
 * An authorized-user file reuses its access token while that token is outside the expiry skew.
 * Otherwise it is refreshed. Service-account files are exchanged for a token.
 * A bare access token is used only when its expiry is still in the future.
 * The file body, private key, and refresh token are not returned and must not be stored.
 */
export async function resolveAdcAccessToken(input: {
  path: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
  now?: number;
}): Promise<string | undefined> {
  const parsed = await readJson(input.path);
  if (!parsed) return undefined;
  const now = input.now ?? Date.now();
  const type = text(parsed.type);
  if (type === "authorized_user" || (!type && text(parsed.refresh_token) && text(parsed.client_id) && text(parsed.client_secret))) {
    const current = usableAccessToken(parsed, now);
    if (current) return current;
    return refreshAuthorizedUser(parsed, input.fetch, input.signal);
  }
  if (type === "service_account" || (!type && text(parsed.private_key) && text(parsed.client_email))) {
    return exchangeServiceAccount(parsed, input.fetch, input.signal, now);
  }
  return usableAccessToken(parsed, now);
}

function usableAccessToken(parsed: Record<string, unknown>, now: number): string | undefined {
  const token = text(parsed.access_token) || text(parsed.token);
  const expiry = expiryMs(parsed);
  if (token && expiry !== undefined && expiry - now > EXPIRY_SKEW_MS) return token;
  return undefined;
}

/** True when the file can produce a token without copying its secrets anywhere. */
export async function adcCanAuthenticate(path: string, now = Date.now()): Promise<boolean> {
  const parsed = await readJson(path);
  if (!parsed) return false;
  const type = text(parsed.type);
  if (type === "authorized_user") return Boolean(text(parsed.refresh_token) && text(parsed.client_id) && text(parsed.client_secret));
  if (type === "service_account") return Boolean(text(parsed.private_key) && text(parsed.client_email));
  if (!type && text(parsed.refresh_token) && text(parsed.client_id) && text(parsed.client_secret)) return true;
  if (!type && text(parsed.private_key) && text(parsed.client_email)) return true;
  const token = text(parsed.access_token) || text(parsed.token);
  const expiry = expiryMs(parsed);
  return Boolean(token && expiry !== undefined && expiry - now > EXPIRY_SKEW_MS);
}

async function refreshAuthorizedUser(parsed: Record<string, unknown>, fetchImpl: typeof fetch, signal: AbortSignal | undefined): Promise<string | undefined> {
  const refresh = text(parsed.refresh_token);
  const clientId = text(parsed.client_id);
  const clientSecret = text(parsed.client_secret);
  if (!refresh || !clientId || !clientSecret) return undefined;
  const tokenUri = httpsTokenUri(parsed.token_uri) ?? TOKEN_URL;
  const response = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    signal,
  });
  if (!response.ok) return undefined;
  const body = await readBody(response);
  signal?.throwIfAborted();
  return accessToken(body);
}

async function exchangeServiceAccount(
  parsed: Record<string, unknown>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  now: number,
): Promise<string | undefined> {
  const email = text(parsed.client_email);
  const key = text(parsed.private_key);
  if (!email || !key) return undefined;
  const tokenUri = httpsTokenUri(parsed.token_uri) ?? TOKEN_URL;
  let assertion = "";
  try {
    assertion = serviceAccountJwt(email, key, tokenUri, Math.floor(now / 1000));
  } catch {
    return undefined;
  }
  const response = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal,
  });
  if (!response.ok) return undefined;
  const body = await readBody(response);
  signal?.throwIfAborted();
  return accessToken(body);
}

function serviceAccountJwt(email: string, privateKey: string, audience: string, issuedAt: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: email,
    scope: CLOUD_PLATFORM,
    aud: audience,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${base64Url(signer.sign(privateKey))}`;
}

function accessToken(parsed: Record<string, unknown> | undefined): string | undefined {
  const seconds = parsed?.expires_in;
  if (seconds !== undefined && (typeof seconds !== "number" || !Number.isFinite(seconds * 1000) || seconds * 1000 <= EXPIRY_SKEW_MS)) {
    return undefined;
  }
  return text(parsed?.access_token);
}

async function readBody(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await response.json() as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function expiryMs(parsed: Record<string, unknown>): number | undefined {
  const raw = parsed.expiry ?? parsed.expires_at ?? parsed.token_expiry ?? parsed.expiry_date;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 10_000_000_000 ? raw * 1000 : raw;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && raw.trim() !== "") return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsedDate = Date.parse(raw);
  return Number.isFinite(parsedDate) ? parsedDate : undefined;
}

function httpsTokenUri(value: unknown): string | undefined {
  const uri = text(value);
  if (!uri) return undefined;
  try {
    const url = new URL(uri);
    if (url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
