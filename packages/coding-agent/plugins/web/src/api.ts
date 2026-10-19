import type { Context } from "@amazme/chord";
import { awaitWithContext, withAbortSignal } from "@amazme/chord/context";
import { isRecord, webURL } from "./config.ts";
import type { WebSettings } from "./config.ts";

class WebFailure extends Error {}

type SearchSource = {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
};

/** A bounded string window never splits a UTF-16 surrogate pair. */
function window(text: string, limit: number): string {
	let end = Math.min(text.length, limit);
	if (end > 0 && end < text.length && /[\ud800-\udbff]/u.test(text[end - 1]!)) end--;
	return text.slice(0, end);
}

export function originalQuestion(text: string | undefined): string | undefined {
	const collapsed = text?.replace(/\s+/gu, " ").trim();
	return collapsed ? Array.from(collapsed).slice(0, 128).join("") : undefined;
}

/** Preserve source order and nullable dates, bounding the text returned to the model and program. */
export function searchResult(payload: unknown, count: number, maxChars: number) {
	if (!isRecord(payload) || !Array.isArray(payload.results)) throw new WebFailure("Invalid DeepSeek Search response");
	const sources: SearchSource[] = [];
	let remaining = maxChars;
	let truncated = payload.results.length > count;
	for (const item of payload.results.slice(0, count)) {
		if (
			!isRecord(item) ||
			typeof item.url !== "string" ||
			typeof item.title !== "string" ||
			typeof item.snippet !== "string" ||
			(item.date !== null && typeof item.date !== "string")
		)
			throw new WebFailure("Invalid DeepSeek Search response");
		webURL(item.url);
		if (item.url.length > remaining) {
			truncated = true;
			break;
		}
		remaining -= item.url.length;
		const source: SearchSource = { url: item.url };
		for (const [key, text] of [
			["title", item.title],
			["snippet", item.snippet],
			["publishedAt", item.date ?? ""],
		] as const) {
			const kept = window(text, remaining);
			if (kept) source[key] = kept;
			remaining -= kept.length;
			if (kept.length < text.length) truncated = true;
		}
		sources.push(source);
	}
	return { provider: "deepseek-search-api", sources, truncated };
}

/** Fetch reports content, not the target site's unknown HTTP status or final URL. */
export function fetchResult(payload: unknown, url: string, maxChars: number) {
	if (
		!isRecord(payload) ||
		typeof payload.content !== "string" ||
		(payload.title !== undefined && typeof payload.title !== "string")
	)
		throw new WebFailure("Invalid DeepSeek Fetch response");
	const content = window(payload.content, maxChars);
	const title = window(payload.title ?? "", Math.max(0, maxChars - content.length));
	return {
		provider: "deepseek-fetch-api",
		url,
		...(title ? { title } : {}),
		content,
		truncated: content.length < payload.content.length || title.length < (payload.title?.length ?? 0),
	};
}

async function readJSON(response: Response, maxBytes: number, context: Context): Promise<unknown> {
	if (Number(response.headers.get("content-length")) > maxBytes) {
		void response.body?.cancel().catch(() => {});
		throw new WebFailure("DeepSeek web response exceeds maxResponseBytes");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new WebFailure("DeepSeek web response has no body");
	const decoder = new TextDecoder();
	let bytes = 0,
		text = "",
		done = false;
	try {
		for (;;) {
			const chunk = await awaitWithContext(reader.read(), context);
			if (chunk.done) {
				done = true;
				break;
			}
			bytes += chunk.value.byteLength;
			if (bytes > maxBytes) throw new WebFailure("DeepSeek web response exceeds maxResponseBytes");
			text += decoder.decode(chunk.value, { stream: true });
		}
		context.abortSignal?.throwIfAborted();
		try {
			const value: unknown = JSON.parse(text + decoder.decode());
			return value;
		} catch {
			throw new WebFailure("DeepSeek web response is not valid JSON");
		}
	} finally {
		// Observe cleanup without letting an uncooperative body retain the invocation.
		if (!done) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** One settings snapshot, one credential resolution and one non-redirecting request. */
export async function requestWeb<T>(
	settings: WebSettings,
	operation: "search" | "fetch",
	body: object,
	resolveKey: (context: Context) => Promise<string | undefined>,
	decode: (payload: unknown) => T,
	context: Context,
): Promise<T> {
	if (!settings.enabled) throw new WebFailure("Web APIs are disabled; the user can enable them with /web on");
	const endpoint = `${settings.baseURL}/${operation}`;
	const controller = new AbortController();
	const bounded = withAbortSignal(controller.signal, context);
	const timer = setTimeout(() => controller.abort(new Error("DeepSeek web request timed out")), settings.timeoutMs);
	let received: Response | undefined;
	try {
		bounded.abortSignal?.throwIfAborted();
		const key = await awaitWithContext(resolveKey(bounded), bounded);
		bounded.abortSignal?.throwIfAborted();
		if (!key)
			throw new WebFailure(
				"DeepSeek web access requires a DeepSeek API key (DEEPSEEK_API_KEY or saved DeepSeek credentials)",
			);
		const pending = fetch(endpoint, {
			method: "POST",
			redirect: "error",
			signal: bounded.abortSignal,
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify(body),
		}).then((response) => {
			received = response;
			if (bounded.abortSignal?.aborted) {
				void response.body?.cancel().catch(() => {});
				bounded.abortSignal.throwIfAborted();
			}
			return response;
		});
		const response = await awaitWithContext(pending, bounded);
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			throw new WebFailure(`DeepSeek ${operation} API returned HTTP ${response.status}`);
		}
		return decode(await readJSON(response, settings.maxResponseBytes, bounded));
	} catch (error) {
		bounded.abortSignal?.throwIfAborted();
		const detail = error instanceof WebFailure ? error.message : "DeepSeek web request failed";
		throw new WebFailure(
			`${detail}. API endpoint: ${endpoint}. The user can change baseURL with /web; it is independent of the chat endpoint.`,
		);
	} finally {
		clearTimeout(timer);
		controller.abort();
		// Also cover cancellation between resolving fetch and claiming its result.
		void received?.body?.cancel().catch(() => {});
	}
}
