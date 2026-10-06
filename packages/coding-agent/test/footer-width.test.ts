import { sliceByColumn, visibleWidth } from "@amazme/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { createUsageTotals } from "../src/core/usage-totals.ts";
import {
	contextPanelLines,
	ContextUsagePanel,
	FooterComponent,
	formatCwdForFooter,
	SessionTopBar,
} from "../src/modes/interactive/components/footer.ts";
import { PopupClose } from "../src/modes/interactive/components/popup-frame.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	contextPercent?: number;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	routedModel?: { model: { id: string }; thinkingLevel?: string };
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: options.contextPercent ?? 12.3 }),
		routedModel: options.routedModel,
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps routing information within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows the physical model a virtual model routed to", () => {
		const session = createSession({
			sessionName: "",
			modelId: "auto",
			reasoning: true,
			thinkingLevel: "high",
			routedModel: { model: { id: "gpt-5.6-luna" }, thinkingLevel: "medium" },
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120)[1]);

		expect(statsLine).toContain("\u2192 gpt-5.6-luna \u2022 medium");
		expect(statsLine).not.toContain("auto \u2022");
		expect(statsLine).not.toContain("high");
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const top = stripAnsi(footer.renderTopBar(120)[0] ?? "");
		expect(top).toContain("$1.250");
		expect(top).toContain("[Dashboard]");
		expect(stripAnsi(footer.render(120).join("\n"))).not.toContain("$1.250");
	});

	it("updates cached usage totals after an entry is appended", () => {
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
		const session = createSession({ sessionName: "", usage });
		const footer = new FooterComponent(session, createFooterData(1));
		expect(stripAnsi(footer.renderTopBar(120)[0] ?? "")).toContain("$0.500");

		session.sessionManager.getEntries().push({ type: "message", message: { role: "assistant", usage } } as never);
		expect(stripAnsi(footer.renderTopBar(120)[0] ?? "")).toContain("$1.000");
	});

	it("moves cache usage and the latest hit rate out of the footer into usage details", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		footer.setShowLocation(false);
		expect(footer.render(120)).toEqual([]);
		expect(footer.usageDetail()).toEqual({
			totals: { input: 100, output: 10, cacheRead: 50, cacheWrite: 50, cost: 0.001 },
			latestCacheHitRate: 25,
		});
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.renderTopBar(120)[0] ?? "")).toContain("$1.234 (sub)");
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.renderTopBar(120)[0] ?? "")).toContain("$0.000 (sub)");
	});

	it("opens the dashboard when its top-right label is clicked", () => {
		const footer = new FooterComponent(createSession({ sessionName: "chat" }), createFooterData(1));
		let clicks = 0;
		const bar = new SessionTopBar(
			footer,
			() => {
				clicks += 1;
			},
			() => {},
		);
		const line = bar.render(80)[0] ?? "";
		const hit = footer.dashboardHitRange();
		expect(hit).toBeDefined();
		expect(stripAnsi(line).slice(hit?.start ?? 0, hit?.end ?? 0)).toBe("[Dashboard]");
		expect(
			bar.handleMouse({ type: "click", button: "left", x: hit?.start ?? 0, y: 0 } as never),
		).toEqual({ handled: true });
		expect(clicks).toBe(1);
		expect(bar.handleMouse({ type: "click", button: "left", x: 0, y: 0 } as never)).toBeUndefined();
		expect(clicks).toBe(1);
	});

	it("shows a percent bar on hover and opens details on click", () => {
		const footer = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		let opened = 0;
		const bar = new SessionTopBar(footer, () => {}, () => {
			opened += 1;
		});
		bar.render(100);
		const hit = footer.contextHitRange();
		expect(hit).toBeDefined();
		expect(stripAnsi(bar.render(100)[0] ?? "")).toContain("/");
		bar.handleMouse({ type: "move", button: "none", x: hit?.start ?? 0, y: 0 } as never);
		const hovered = stripAnsi(bar.render(100)[0] ?? "");
		expect(hovered).toContain("12.3%");
		expect(hovered).toContain("█");
		const hoveredHit = footer.contextHitRange();
		bar.handleMouse({ type: "click", button: "left", x: hoveredHit?.start ?? 0, y: 0 } as never);
		expect(opened).toBe(1);
		const panel = contextPanelLines(
			{
				used: 338_000,
				window: 500_000,
				percent: 67.6,
				model: "test-model",
				cost: 1.2,
				usageTotals: { ...createUsageTotals(), cost: 1.2 },
				latestCacheHitRate: null,
				subscription: false,
				autoCompact: true,
				reserveTokens: 16_384,
				messages: 4,
				toolCalls: 2,
				compactions: 1,
			},
			60,
		).join("\n");
		expect(panel).toContain("338k / 500k tokens (67.6%)");
		expect(panel).toContain("◆");
		expect(panel).toContain("◇");
		expect(panel).toContain("Messages        4");
		expect(panel).not.toContain("System prompt");
	});

	it("closes the context popup from the top-right badge", () => {
		let closed = 0;
		const panel = new ContextUsagePanel(
			() => ({
				used: 1,
				window: 10,
				percent: 10,
				model: "m",
				cost: 0,
				usageTotals: createUsageTotals(),
				latestCacheHitRate: null,
				subscription: false,
				autoCompact: false,
				reserveTokens: 1,
				messages: 0,
				toolCalls: 0,
				compactions: 0,
			}),
			() => {
				closed += 1;
			},
		);
		const line = stripAnsi(panel.render(40)[0] ?? "");
		expect(line.endsWith("[x]╮")).toBe(true);
		const badge = line.lastIndexOf("[x]");
		expect(panel.handleMouse({ type: "click", button: "left", x: badge, y: 0 } as never)).toEqual({ handled: true });
		expect(closed).toBe(1);
		expect(panel.handleMouse({ type: "click", button: "left", x: 0, y: 0 } as never)).toBeUndefined();
		expect(closed).toBe(1);
	});

	it("puts a close badge on the top-right of a dialog", () => {
		let closed = 0;
		const popup = new PopupClose({ render: () => ["body"], invalidate() {} }, () => {
			closed += 1;
		});
		const lines = popup.render(10);
		expect(stripAnsi(lines[0] ?? "").endsWith("[x]")).toBe(true);
		expect(lines[1]).toBe("body");
		expect(popup.handleMouse({ type: "click", button: "left", x: 7, y: 0 } as never)).toEqual({ handled: true });
		expect(closed).toBe(1);
	});

	it("keeps the Dashboard entry clickable and preserves a Unicode title at narrow widths", () => {
		const footer = new FooterComponent(createSession({ sessionName: "会话标题".repeat(10) }), createFooterData(1));
		let opened = 0;
		const bar = new SessionTopBar(footer, () => { opened += 1; }, () => {});
		for (const width of [1, 2, 3, 8, 16, 24, 32, 40, 80, 120]) {
			const line = bar.render(width)[0]!;
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const hit = footer.dashboardHitRange()!;
			expect(hit).toBeDefined();
			expect(stripAnsi(sliceByColumn(line, hit.start, hit.end - hit.start))).toBe(width >= 32 ? "[Dashboard]" : width >= 3 ? "[D]" : "D");
			bar.handleMouse({ type: "click", button: "left", x: hit.start, y: 0 } as never);
			if (width >= 16) expect(stripAnsi(line)).toMatch(/^会话/);
		}
		expect(opened).toBe(10);
		expect(bar.render(0)).toEqual([""]);
		expect(footer.dashboardHitRange()).toBeUndefined();
	});

	it("keeps context warnings and titles ahead of location and cost on narrow screens", () => {
		const footer = new FooterComponent(createSession({
			sessionName: "重要会话标题",
			contextPercent: 94,
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 1.234 } },
		}), createFooterData(1));
		const line = stripAnsi(footer.renderTopBar(24)[0]!);
		expect(line).toContain("重要会话标题");
		expect(line).toContain("94%");
		expect(line).toContain("[D]");
		expect(line).not.toContain("/tmp/project");
		expect(line).not.toContain("$1.234");
		expect(footer.contextHitRange()).toBeDefined();
	});

	it("context hover does not move the title or Dashboard click target", () => {
		const footer = new FooterComponent(createSession({ sessionName: "Stable title" }), createFooterData(1));
		for (const width of [24, 40, 100]) {
			footer.setContextHover(false);
			const before = stripAnsi(footer.renderTopBar(width)[0]!);
			const hit = footer.dashboardHitRange();
			const context = footer.contextHitRange();
			footer.setContextHover(true);
			const after = stripAnsi(footer.renderTopBar(width)[0]!);
			expect(footer.dashboardHitRange()).toEqual(hit);
			expect(footer.contextHitRange()).toEqual(context);
			expect(before.slice(0, context?.start)).toBe(after.slice(0, context?.start));
		}
	});

	it("omits location and usage without dropping routing or extension status", () => {
		const session = createSession({
			sessionName: "chat",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			routedModel: { model: { id: "physical-model" } },
		});
		const provider = { ...createFooterData(1), getExtensionStatuses: () => new Map([["status", "Extension status"]]) };
		const footer = new FooterComponent(session, provider);
		footer.setShowLocation(false);
		const lines = footer.render(100).map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).not.toMatch(/↑|↓|CH|R\d|W\d/);
		expect(lines[0]).toContain("physical-model");
		expect(lines[1]).toBe("Extension status");
		expect(lines.join("\n")).not.toContain("/tmp/project");
		expect(lines.join("\n")).not.toContain("chat");
		const empty = new FooterComponent(createSession({ sessionName: "chat" }), createFooterData(1));
		empty.setShowLocation(false);
		expect(empty.render(80)).toEqual([]);
	});

	it("does not mark generic OAuth sign-in as a subscription", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.renderTopBar(120)[0] ?? "");

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});
});
