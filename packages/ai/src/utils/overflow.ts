export type TransportKind = "quota" | "authentication" | "invalid_request" | "rate_limit" | "unavailable" | "server" | "overflow";

export interface TransportClassification {
  kind: TransportKind;
  retryable: boolean;
  overflow: boolean;
}

const QUOTA = /insufficient_quota|quota_exceeded|exceeded your current quota|billing|out of credits|credit balance/i;
const AUTH = /invalid_api_key|authentication_error|permission_error|access_denied/i;
const RATE = /rate_limit|too many requests/i;
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);
const OVERFLOW_CODE = /^(context_length_exceeded|model_context_window_exceeded)$/i;
const OVERFLOW_TEXT = [
  /context[_ ]length[_ ]exceeded/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /maximum context length is \d+/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /input length \(\d+\) exceeds the model'?s maximum context length/i,
];

/**
 * Classify an HTTP or SSE failure.
 * An explicit overflow code wins. Message patterns cover a small set of maximum-context
 * and maximum-input errors. Bare 400/413, `length`, and "too many tokens" are not overflow.
 * Quota, billing, auth, and rate limits are not overflow. This does not resend the request.
 */
export function classifyTransportFailure(status: number | undefined, body: string): TransportClassification {
  const fields = errorFields(body);
  const haystack = `${fields.type ?? ""}\n${fields.code ?? ""}\n${fields.message ?? ""}`;
  if (OVERFLOW_CODE.test(fields.code ?? "") || OVERFLOW_CODE.test(fields.type ?? "")) {
    return { kind: "overflow", retryable: false, overflow: true };
  }
  if (status === 402 || QUOTA.test(haystack)) return plain("quota", false);
  if (status === 401 || status === 403 || AUTH.test(haystack)) return plain("authentication", false);
  const excluded = QUOTA.test(haystack) || AUTH.test(haystack) || RATE.test(haystack) || status === 429;
  if (!excluded && OVERFLOW_TEXT.some((pattern) => pattern.test(haystack))) {
    return { kind: "overflow", retryable: false, overflow: true };
  }
  if (status === 400 || status === 404 || status === 422) return plain("invalid_request", false);
  if (fields.type === "invalid_request_error" && status !== 429) return plain("invalid_request", false);
  if (status === 429 || RATE.test(haystack)) return plain("rate_limit", true);
  if (status === undefined && (fields.type === "server_error" || fields.type === "overloaded_error")) {
    return plain("unavailable", true);
  }
  if (status !== undefined && RETRYABLE_STATUS.has(status)) return plain("unavailable", true);
  return plain("server", false);
}

export function transportErrorDetail(body: string): string {
  return errorFields(body).message ?? body;
}

/**
 * A `length` stop with no output whose input already fills the window.
 * Ordinary truncation (any generated output, or input still inside the window) stays `length`.
 */
export function isFilledWindowLength(
  message: { stopReason: string; usage: { input: number; output: number } },
  contextWindow: number,
): boolean {
  return message.stopReason === "length"
    && message.usage.output === 0
    && Number.isFinite(contextWindow)
    && contextWindow > 0
    && message.usage.input >= contextWindow * 0.99;
}

function plain(kind: Exclude<TransportKind, "overflow">, retryable: boolean): TransportClassification {
  return { kind, retryable, overflow: false };
}

function errorFields(body: string): { type?: string; code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; code?: unknown; message?: unknown } };
    const error = parsed.error;
    if (!error || typeof error !== "object") return { message: body };
    return {
      ...(typeof error.type === "string" ? { type: error.type } : {}),
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.message === "string" ? { message: error.message } : { message: body }),
    };
  } catch {
    return { message: body };
  }
}
