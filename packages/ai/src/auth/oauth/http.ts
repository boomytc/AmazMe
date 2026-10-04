import type { LoginInteraction } from "../../auth.ts";
import type { OAuthCredential } from "../../types.ts";

export function signalOf(interaction: Pick<LoginInteraction, "signal">): AbortSignal {
  const signal = interaction.signal ?? new AbortController().signal;
  checkCancelled(signal);
  return signal;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readJson(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const text = await response.text();
  checkCancelled(signal);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return { raw: text };
  }
}

export async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<Response> {
  checkCancelled(signal);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
    signal,
  });
  checkCancelled(signal);
  return response;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Login cancelled");
}

export function expiresIn(seconds: unknown, fallbackSeconds = 3600): number {
  const value = seconds === undefined ? fallbackSeconds : seconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("OAuth response has invalid expires_in");
  }
  const expires = Date.now() + value * 1000;
  if (!Number.isFinite(expires)) throw new Error("OAuth response has invalid expires_in");
  return expires;
}

export function credential(access: string, refresh: string, expires: number, extra: Partial<OAuthCredential> = {}): OAuthCredential {
  return { type: "oauth", access, refresh, expires, ...extra };
}

export function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function accountIdFromJwt(access: string): string | undefined {
  const payload = access.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!isRecord(json)) return undefined;
    const claim = json["https://api.openai.com/auth"];
    if (!isRecord(claim)) return undefined;
    return typeof claim.chatgpt_account_id === "string" && claim.chatgpt_account_id.length > 0 ? claim.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}
