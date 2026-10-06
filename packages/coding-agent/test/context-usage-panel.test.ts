import {
	Container,
	getKeybindings,
	isViewportTUI,
	setKeybindings,
	Text,
	type TuiMouseEvent,
	visibleWidth,
} from "@amazme/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	type ContextDetail,
	ContextUsagePanel,
	contextPanelLines,
	FooterComponent,
	SessionTopBar,
} from "../src/modes/interactive/components/footer.ts";
import {
	createInteractiveTui,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import {
	getEditorTheme,
	initTheme,
} from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const prototype = InteractiveMode.prototype as unknown as {
	contextDetail(this: unknown): ContextDetail;
	toggleContextPanel(this: unknown): void;
};
const footerData = {
	getGitBranch: () => "main",
	getExtensionStatuses: () => new Map<string, string>(),
	getAvailableProviderCount: () => 3,
	onBranchChange: () => () => {},
};
const usage = {
	input: 100,
	output: 10,
	cacheRead: 50,
	cacheWrite: 50,
	cost: { total: 0.001 },
};
const originalKeys = getKeybindings();
afterEach(() => {
	setKeybindings(originalKeys);
	vi.unstubAllEnvs();
});
beforeAll(() => initTheme("dark", false));

function fixture(hasUsage = true) {
	const entries: Array<Record<string, unknown>> = hasUsage
		? [{ type: "message", message: { role: "assistant", usage } }]
		: [];
	const sessionManager = {
		getEntries: () => entries,
		getEntryCount: () => entries.length,
		getSessionId: () => "test",
		getLeafId: () => null,
		getSessionName: () => "Current session",
		getCwd: () => "/repo",
	};
	const session = {
		sessionManager,
		state: {
			model: {
				id: "test-model",
				provider: "test-provider",
				contextWindow: 200_000,
			},
		},
		getContextUsage: () => ({
			tokens: 24_600,
			contextWindow: 200_000,
			percent: 12.3,
		}),
		modelRuntime: { isUsingSubscription: () => false },
		autoCompactionEnabled: true,
	} as unknown as AgentSession;
	const footer = new FooterComponent(session, footerData);
	footer.setShowLocation(false);
	const context = {
		session,
		sessionManager,
		footer,
		settingsManager: {
			getCompactionSettings: () => ({ reserveTokens: 16_384 }),
		},
	};
	return {
		entries,
		session,
		footer,
		detail: () => prototype.contextDetail.call(context),
	};
}

function plain(detail: ContextDetail, width = 68): string[] {
	return contextPanelLines(detail, width).map(stripAnsi);
}

describe("context usage details", () => {
	it("moves all usage information into labelled groups without duplicating the footer or provider", () => {
		const { footer, detail } = fixture();
		expect(footer.render(100)).toEqual([]);
		const lines = plain(detail());
		expect(lines[0]).toBe("25k / 200k tokens (12.3%)");
		expect(lines).toContain("Session totals");
		expect(lines).toContain("Input (uncached)  100");
		expect(lines).toContain("Output            10");
		expect(lines).toContain("Cache reads       50");
		expect(lines).toContain("Cache writes      50");
		expect(lines).toContain("Cost              $0.001");
		expect(lines).toContain("Last assistant request");
		expect(lines).toContain("Cache hit rate    25.0%");
		expect(lines).toContain("Not the context occupancy percentage.");
		expect(plain(detail()).join("\n")).not.toContain("CH25.0%");
		expect(stripAnsi(footer.renderTopBar(100)[0] ?? "")).toContain("$0.001");
	});

	it("accumulates summaries, tools, and usage entries without replacing the latest assistant cache rate", () => {
		const { entries, detail } = fixture();
		const extra = {
			input: 10,
			output: 1,
			cacheRead: 1,
			cacheWrite: 0,
			cost: { total: 0.1 },
		};
		entries.push(
			{ type: "branch_summary", usage: extra },
			{ type: "compaction", usage: extra },
			{ type: "message", message: { role: "toolResult", usage: extra } },
			{ type: "usage", usage: extra },
		);
		const value = detail();
		expect(value.usageTotals).toEqual({
			input: 140,
			output: 14,
			cacheRead: 54,
			cacheWrite: 50,
			cost: 0.401,
		});
		expect(value.latestCacheHitRate).toBe(25);
		expect(value.messages).toBe(1);
		expect(value.toolCalls).toBe(1);
		expect(value.compactions).toBe(1);
	});

	it("refreshes after a new response and does not substitute the cumulative cache rate", () => {
		const { entries, detail } = fixture();
		const before = detail();
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 100,
					output: 20,
					cacheRead: 900,
					cacheWrite: 0,
					cost: { total: 0.002 },
				},
			},
		});
		expect(detail().usageTotals).toEqual({
			input: 200,
			output: 30,
			cacheRead: 950,
			cacheWrite: 50,
			cost: 0.003,
		});
		expect(detail().latestCacheHitRate).toBe(90);
		expect(before.usageTotals.cacheRead).toBe(50);
	});

	it("shows zero totals and an unrecorded rate before a request, but a real uncached request has a zero hit rate", () => {
		const { entries, detail } = fixture(false);
		expect(detail().latestCacheHitRate).toBeNull();
		expect(plain(detail())).toContain("Cache hit rate    Not recorded");
		expect(plain(detail())).toContain("Cache reads       0");
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage: { ...usage, cacheRead: 0, cacheWrite: 0 },
			},
		});
		expect(detail().latestCacheHitRate).toBe(0);
		expect(plain(detail())).toContain("Cache hit rate    0.0%");
	});

	it("preserves cumulative usage while current context is unknown after compaction", () => {
		const { session, detail } = fixture();
		session.getContextUsage = () => ({
			tokens: null,
			contextWindow: 200_000,
			percent: null,
		});
		expect(plain(detail())[0]).toBe("? / 200k tokens (?)");
		expect(detail().usageTotals.cacheRead).toBe(50);
		expect(detail().latestCacheHitRate).toBe(25);
	});

	it("shows exact large counts and subscription cost labels, and fits Unicode/narrow widths", () => {
		const value = fixture().detail();
		value.usageTotals = {
			input: 1_100_000,
			output: 230_000,
			cacheRead: 22_000_000,
			cacheWrite: 0,
			cost: 1.234,
		};
		value.cost = 1.234;
		value.subscription = true;
		value.model = "中文模型".repeat(20);
		expect(plain(value)).toContain("Cache reads       22,000,000");
		expect(plain(value)).toContain("Cost              $1.234 (sub)");
		expect(plain(value, 20)).toContain("22,000,000");
		for (const width of [0, 1, 8, 24, 40, 68]) {
			for (const line of contextPanelLines(value, width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("preserves Dashboard hints, routing, experiment markers, and extension status without provider labels", () => {
		const { session } = fixture();
		Object.assign(session, {
			routedModel: { model: { id: "physical-model" }, thinkingLevel: "medium" },
		});
		const footer = new FooterComponent(session, {
			...footerData,
			getExtensionStatuses: () => new Map([["status", "Extension ready"]]),
		});
		footer.setShowLocation(false);
		footer.setComposerLine(() => "Ctrl+\\:dashboard");
		vi.stubEnv("AMAZME_EXPERIMENTAL", "1");
		const lines = footer.render(100).map(stripAnsi);
		expect(lines[0]).toContain("xp");
		expect(lines[0]).toContain("→ physical-model • medium");
		expect(lines).toContain("Ctrl+\\:dashboard");
		expect(lines).toContain("Extension ready");
		expect(lines.join("\n")).not.toContain("test-provider");
		expect(lines.join("\n")).not.toMatch(/↑\d|↓\d|CH\d|R\d|W\d/);
	});
});

describe("bounded context detail panel", () => {
	it("scrolls with configured keys and the wheel while keeping its close badge fixed", () => {
		const { detail } = fixture();
		const onClose = vi.fn();
		const requestRender = vi.fn();
		let height = 10;
		const panel = new ContextUsagePanel(detail, onClose, {
			maxHeight: () => height,
			requestRender,
		});
		expect(panel.render(72)).toHaveLength(10);
		for (const width of [0, 1, 8, 24]) {
			for (const line of panel.render(width))
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		panel.render(72);
		panel.handleInput("\x1b[4~");
		expect(panel.render(72).map(stripAnsi).join("\n")).toContain(
			"Cache hit rate    25.0%",
		);
		const top = stripAnsi(panel.render(72)[0] ?? "");
		expect(top.endsWith("[x]╮")).toBe(true);
		panel.handleInput("\x1b[1~");
		expect(panel.render(72).map(stripAnsi).join("\n")).toContain("25k / 200k");
		setKeybindings(new KeybindingsManager({ "tui.select.pageDown": "ctrl+j" }));
		panel.handleInput("\n");
		expect(panel.render(72).map(stripAnsi).join("\n")).not.toContain(
			"25k / 200k",
		);
		expect(
			panel.handleMouse({ type: "wheel", wheelDelta: 100 } as TuiMouseEvent),
		).toEqual({ handled: true });
		expect(panel.render(72).map(stripAnsi).join("\n")).toContain(
			"Cache hit rate    25.0%",
		);
		height = 40;
		const expanded = panel.render(72).map(stripAnsi).join("\n");
		expect(expanded).toContain("25k / 200k");
		expect(expanded).toContain("Cache hit rate    25.0%");
		expect(expanded).not.toContain("scroll ·");
		panel.handleMouse({
			type: "click",
			button: "left",
			x: 68,
			y: 0,
		} as TuiMouseEvent);
		expect(onClose).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalled();
	});

	it.each(["regular", "fullscreen"] as const)(
		"all sections remain reachable in a 24-row %s terminal without scrolling the transcript",
		async (mode) => {
			const { footer, detail } = fixture();
			const terminal = new VirtualTerminal(80, 24);
			const ui = createInteractiveTui({
				tuiMode: mode,
				terminal,
				showHardwareCursor: false,
				logDirectory: "/tmp",
			});
			const editor = new CustomEditor(
				ui,
				getEditorTheme(),
				new KeybindingsManager(),
			);
			const context = { ui, contextDetail: detail, contextOverlay: undefined };
			const bar = new SessionTopBar(
				footer,
				() => {},
				() => prototype.toggleContextPanel.call(context),
			);
			const document = new Text(
				Array.from({ length: 60 }, (_, i) => `Transcript ${i}`).join("\n"),
				0,
				0,
			);
			ui.addChild(document);
			ui.addChild(editor);
			const viewport = createChatViewport({
				document,
				statusBar: bar,
				editor,
				pendingMessages: new Container(),
				status: new Container(),
				footer: new Container(),
			});
			if (isViewportTUI(ui)) ui.setLayoutRoot(viewport.root);
			ui.setFocus(editor);
			ui.start();
			try {
				await terminal.waitForRender();
				const initialScroll = viewport.transcript.scrollTop;
				prototype.toggleContextPanel.call(context);
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("Session totals");
				terminal.sendInput("\x1b[4~");
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain(
					"Cache hit rate    25.0%",
				);
				expect(viewport.transcript.scrollTop).toBe(initialScroll);
				terminal.sendInput("q");
				await terminal.waitForRender();
				expect(ui.hasOverlayEntries).toBe(false);
				expect(ui.getFocusedComponent()).toBe(editor);
				expect(viewport.transcript.scrollTop).toBe(initialScroll);
			} finally {
				ui.stop();
			}
		},
	);
});
