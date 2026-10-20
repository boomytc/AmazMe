import { defineDoc } from "@amazme/durable";

export type WebSettings = {
	enabled: boolean;
	baseURL: string;
	count: number;
	sendOriginalQuestion: boolean;
	timeoutMs: number;
	maxResponseBytes: number;
	maxContentChars: number;
};

export const DEFAULT_WEB_SETTINGS: Readonly<WebSettings> = Object.freeze({
	enabled: false,
	baseURL: "https://api.deepseek.com/v1/tools",
	count: 10,
	sendOriginalQuestion: true,
	timeoutMs: 30_000,
	maxResponseBytes: 2 * 1024 * 1024,
	maxContentChars: 20_000,
});

/** User-owned selection; endpoints and credentials never come from tool arguments. */
export const WebPolicy = defineDoc<WebSettings>({
	kind: "amazme.web.policy",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ ...DEFAULT_WEB_SETTINGS }),
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
});

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate addresses before resolving credentials or dispatching a request. */
export function webURL(value: string): URL {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
		throw new Error("Web addresses must use HTTP or HTTPS without a username or password");
	return url;
}

function integer(value: unknown, name: string, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
		throw new Error(`${name} must be an integer from 1 to ${max}`);
	return value;
}

/** Validate persisted settings as well as user JSON; invalid settings dispatch nothing. */
export function readWebSettings(value: unknown): WebSettings {
	if (!isRecord(value) || Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_WEB_SETTINGS, key)))
		throw new Error("Unknown web setting");
	if (typeof value.enabled !== "boolean" || typeof value.sendOriginalQuestion !== "boolean")
		throw new Error("enabled and sendOriginalQuestion must be booleans");
	if (typeof value.baseURL !== "string" || value.baseURL.length > 8192)
		throw new Error("baseURL must be an HTTP or HTTPS API base including its path prefix");
	const url = webURL(value.baseURL);
	if (url.search || url.hash) throw new Error("baseURL cannot contain a query or fragment");
	return {
		enabled: value.enabled,
		baseURL: url.href.replace(/\/+$/u, ""),
		count: integer(value.count, "count", 50),
		sendOriginalQuestion: value.sendOriginalQuestion,
		timeoutMs: integer(value.timeoutMs, "timeoutMs", 300_000),
		maxResponseBytes: integer(value.maxResponseBytes, "maxResponseBytes", 16 * 1024 * 1024),
		maxContentChars: integer(value.maxContentChars, "maxContentChars", 200_000),
	};
}

/** Only the user command changes policy; model tools cannot enable access or choose the API endpoint. */
export function editWebSettings(current: WebSettings, args: string): WebSettings {
	const text = args.trim();
	if (text === "on" || text === "off") return readWebSettings({ ...current, enabled: text === "on" });
	const patch: unknown = JSON.parse(text);
	if (!isRecord(patch)) throw new Error("Web settings must be a JSON object");
	return readWebSettings({ ...current, ...patch });
}
