/// <reference lib="dom" />
/**
 * Development-only transcript scale route (`?perf=N`).
 *
 * It renders a synthetic conversation without connecting to a host, then reports the
 * projection, DOM build, node count, and scroll frame timings on `globalThis.__AMAZME_PERF__`.
 * It exists for measuring layout and paint in a real browser; nothing in the product reads it.
 */
import type { AssistantMessage, UserMessage } from "@amazme/ai";
import {
	AssistantEntry,
	type ConversationId,
	type ConversationView,
	type EntryId,
	type EntryRecord,
	type JsonObject,
	UserEntry,
} from "@amazme/durable";
import { buildWebView, transcriptBlocks, type WebViewInput } from "@amazme/web";

const CONVERSATION = 1 as ConversationId;

export interface PerfResult {
	readonly blocks: number;
	readonly projectionMs: number;
	readonly renderMs: number;
	readonly nodes: number;
	readonly scroll: {
		readonly frames: number;
		readonly averageMs: number;
		readonly p95Ms: number;
	};
}

/** Opt-in flag a browser sets before opening the route; without it the product never sees it. */
export const PERF_FLAG = "amazme.perf";

/** The requested synthetic block count, capped so a typo cannot freeze the tab. */
export function perfCount(href: string): number | undefined {
	try {
		const raw = new URL(href).searchParams.get("perf");
		if (raw === null) return undefined;
		const value = Number.parseInt(raw, 10);
		if (!Number.isFinite(value) || value <= 0) return undefined;
		return Math.min(value, 5000);
	} catch {
		return undefined;
	}
}

/** The route needs both the flag and a count, so a stray `?perf=` never replaces a real transcript. */
export function perfRequest(
	href: string,
	storage: { getItem(key: string): string | null } | undefined,
): number | undefined {
	if (storage === undefined) return undefined;
	try {
		if (storage.getItem(PERF_FLAG) !== "1") return undefined;
	} catch {
		return undefined;
	}
	return perfCount(href);
}

function entries(count: number): EntryRecord[] {
	const list: EntryRecord[] = [];
	for (let index = 0; index < count; index++) {
		const id = (index + 1) as EntryId;
		if (index % 2 === 0) {
			const message: UserMessage = { role: "user", content: `question ${index}`, timestamp: index };
			list.push({ id, conversationId: CONVERSATION, kind: UserEntry.kind, model: [message] });
			continue;
		}
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: `answer ${index} ${"detail ".repeat(30)}` }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: index,
		};
		list.push({ id, conversationId: CONVERSATION, kind: AssistantEntry.kind, model: [message] });
	}
	return list;
}

function viewOf(list: EntryRecord[]): ConversationView {
	return {
		conversation: { id: CONVERSATION, createdAt: 0 } as unknown as ConversationView["conversation"],
		entries: list,
		docs: {} as Record<string, JsonObject>,
	};
}

function input(view: ConversationView): WebViewInput {
	return {
		locale: "en",
		submitMode: "followUp",
		attachments: [],
		rosterFilter: "",
		approvals: undefined,
		feedback: undefined,
		showWelcome: false,
		focus: undefined,
		history: [],
		historyMore: false,
		historyLoading: false,
		draft: "",
		commands: [],
		completions: [],
		paletteSelection: 0,
		platform: "",
		dock: { open: false, tab: "files", cwd: "", workspace: undefined, terminal: undefined, conversations: undefined },
		panel: { locale: "en", current: "chat" },
		directory: undefined,
		transcript: view,
		attachedId: "perf",
		now: 0,
		models: undefined,
		thinkingLevels: [],
	};
}

function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

/** Render the synthetic conversation and measure frames while scrolling through it. */
export async function runPerfCase(
	renderer: { render(view: ReturnType<typeof buildWebView>): void },
	count: number,
): Promise<PerfResult> {
	const started = performance.now();
	const view = viewOf(entries(count));
	const blocks = transcriptBlocks("en", view);
	const projected = performance.now();
	renderer.render(buildWebView(input(view)));
	const rendered = performance.now();
	const nodes = document.body.querySelectorAll("*").length;

	const transcript = document.getElementById("transcript");
	const frames: number[] = [];
	if (transcript !== null) {
		const max = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
		for (let index = 0; index < 30; index++) {
			const before = performance.now();
			transcript.scrollTop = max === 0 ? 0 : Math.round((max * index) / 29);
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			frames.push(performance.now() - before);
		}
	}
	const result: PerfResult = {
		blocks: blocks.length,
		projectionMs: Math.round((projected - started) * 100) / 100,
		renderMs: Math.round((rendered - projected) * 100) / 100,
		nodes,
		scroll: {
			frames: frames.length,
			averageMs: Math.round((frames.reduce((sum, value) => sum + value, 0) / Math.max(1, frames.length)) * 100) / 100,
			p95Ms: Math.round(percentile(frames, 0.95) * 100) / 100,
		},
	};
	(globalThis as { __AMAZME_PERF__?: PerfResult }).__AMAZME_PERF__ = result;
	console.log(`AMAZME_PERF ${JSON.stringify(result)}`);
	return result;
}
