import type { LoginInteraction } from "../../auth.ts";
import type { OAuthCredential } from "../../types.ts";

export function signalOf(interaction: Pick<LoginInteraction, "signal">): AbortSignal {
  return interaction.signal ?? new AbortController().signal;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
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
  return fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
    signal,
  });
}

export function expiresIn(seconds: unknown, fallbackSeconds = 3600): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds;
  return Date.now() + value * 1000;
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
