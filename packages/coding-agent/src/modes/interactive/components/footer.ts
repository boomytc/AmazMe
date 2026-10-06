import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	type Component,
	matchesKey,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@amazme/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";
import { popupCloseClicked, popupFrame } from "./popup-frame.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private composerLine: (() => string | undefined) | undefined;
	private dashboardHit: { start: number; end: number } | undefined;
	private contextHit: { start: number; end: number } | undefined;
	private contextHover = false;
	private showLocation = true;

	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private sessionStats?: SessionStats;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	/** The interactive top bar owns location; standalone footers can still include it. */
	setShowLocation(show: boolean): void {
		this.showLocation = show;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/** Enter/queue hint rendered under the session stats. */
	setComposerLine(provider: () => string | undefined): void {
		this.composerLine = provider;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			contextUsage,
		};
		return this.sessionStats;
	}

	/** Fixed top line: where you are on the left, context, cost, and Dashboard on the right. */
	renderTopBar(width: number): string[] {
		const state = this.session.state;
		const { usageTotals, contextUsage } = this.getSessionStats();
		this.dashboardHit = undefined;
		this.contextHit = undefined;
		if (width <= 0) return [""];
		const sessionName = sanitizeStatusText(stripTerminalSequences(this.session.sessionManager.getSessionName() ?? ""));
		const place = sanitizeStatusText(stripTerminalSequences(this.placeLabel()));
		const directory = sanitizeStatusText(
			stripTerminalSequences(this.session.sessionManager.getCwd().split(/[\\/]/).filter(Boolean).at(-1) ?? place),
		);
		const primary = sessionName || directory;
		const dashboard = width >= 32 ? "[Dashboard]" : width >= 3 ? "[D]" : "D";
		const primaryBudget = Math.min(visibleWidth(primary), width >= 24 ? 12 : 4);
		const contextBudget = Math.max(0, width - primaryBudget - visibleWidth(dashboard) - 3);
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const used = contextUsage?.tokens === null || contextUsage?.tokens === undefined ? "?" : formatTokens(contextUsage.tokens);
		const percent = contextUsage?.percent;
		const fullContext = `${used} / ${formatTokens(contextWindow)}`;
		const compactContext = percent === null || percent === undefined ? "ctx?" : `${Math.round(percent)}%`;
		const meter = percent === null || percent === undefined ? fullContext : contextMeter(percent);
		const normalContext =
			visibleWidth(fullContext) <= contextBudget
				? fullContext
				: visibleWidth(compactContext) <= contextBudget ? compactContext : "";
		const expandedWidth = Math.max(visibleWidth(normalContext), visibleWidth(meter));
		const contextWidth = normalContext
			? (expandedWidth <= contextBudget ? expandedWidth : visibleWidth(normalContext)) : 0;
		const contextPlain = this.contextHover && normalContext
			? (visibleWidth(meter) <= contextWidth ? meter : compactContext) : normalContext;
		const contextColor =
			percent !== null && percent !== undefined && percent > 90
				? "error"
				: percent !== null && percent !== undefined && percent > 70
					? "warning"
					: "dim";
		const context = contextPlain
			? theme.fg(contextColor, contextPlain) + " ".repeat(Math.max(0, contextWidth - visibleWidth(contextPlain))) : "";
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		const costLabel = usageTotals.cost || usingSubscription
			? `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}` : "";
		const cost =
			costLabel && visibleWidth(primary) + contextWidth + visibleWidth(costLabel) + visibleWidth(dashboard) + 6 <= width
				? theme.fg("dim", costLabel) : "";
		const right = [context, cost, theme.fg("accent", dashboard)].filter(Boolean).join("  ");
		const rightWidth = visibleWidth(right);
		const available = Math.max(0, width - rightWidth - 1);
		const candidates = sessionName
			? [`${sessionName} • ${place}`, `${sessionName} • ${directory}`, sessionName] : [place, directory];
		const left = candidates.find((text) => visibleWidth(text) <= available) ?? truncateToWidth(primary, available, "…");
		const rightStart = width - rightWidth;
		this.dashboardHit = { start: width - visibleWidth(dashboard), end: width };
		if (contextWidth > 0) this.contextHit = { start: rightStart, end: rightStart + contextWidth };
		return [theme.fg("dim", left) + " ".repeat(Math.max(0, rightStart - visibleWidth(left))) + right];
	}

	dashboardHitRange(): { start: number; end: number } | undefined {
		return this.dashboardHit;
	}

	contextHitRange(): { start: number; end: number } | undefined {
		return this.contextHit;
	}

	setContextHover(hover: boolean): void {
		this.contextHover = hover;
	}

	contextHovering(): boolean {
		return this.contextHover;
	}

	usageCost(): number {
		return this.getSessionStats().usageTotals.cost;
	}

	private placeLabel(): string {
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		return pwd;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const { usageTotals, latestCacheHitRate } = this.getSessionStats();
		let pwd = this.placeLabel();

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}
		// Build stats line
		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		let statsLeft = statsParts.join(" ");

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// The prompt border already shows the selected model and its thinking level.
		// The footer keeps only what that border does not: the provider, and where a virtual model routed.
		const rightParts: string[] = [];
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightParts.push(`(${state.model.provider})`);
		}
		const routed = this.session.routedModel;
		if (routed) {
			const level = routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : "";
			rightParts.push(`→ ${routed.model.id}${level}`);
		}
		const rightSide = rightParts.join(" ");
		const minPadding = 2;
		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + (rightSide.length > 0 ? minPadding + rightSideWidth : 0);

		let statsLine: string;
		if (rightSide.length === 0 || totalNeeded <= width) {
			const padding = rightSide.length === 0 ? "" : " ".repeat(Math.max(0, width - statsLeftWidth - rightSideWidth));
			statsLine = statsLeft + padding + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const statsLineRendered = dimStatsLeft + dimRemainder;
		const lines = [
			...(this.showLocation ? [pwdLine] : []),
			...(visibleWidth(statsLineRendered) > 0 ? [statsLineRendered] : []),
		];
		const composerLine = this.composerLine?.();
		if (composerLine) lines.push(truncateToWidth(theme.fg("dim", composerLine), width, theme.fg("dim", "...")));

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}

function contextMeter(percent: number): string {
	const cells = 12;
	const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
	return `${"█".repeat(filled)}${"░".repeat(cells - filled)} ${percent.toFixed(1)}%`;
}

export interface ContextDetail {
	used: number | null;
	window: number;
	percent: number | null;
	model: string;
	cost: number;
	subscription: boolean;
	autoCompact: boolean;
	reserveTokens: number;
	messages: number;
	toolCalls: number;
	compactions: number;
}

/** Detail card for the context meter. Counts only what the session log actually records. */
export function contextPanelLines(detail: ContextDetail, width: number): string[] {
	const used = detail.used === null ? "?" : formatTokens(detail.used);
	const percent = detail.percent === null ? "?" : `${detail.percent.toFixed(1)}%`;
	const cells = 40;
	const fraction = detail.percent === null ? 0 : Math.max(0, Math.min(100, detail.percent));
	const filled = Math.round((fraction / 100) * cells);
	const grid = `${"◆".repeat(filled)}${"◇".repeat(cells - filled)}`;
	const remaining =
		detail.used === null ? "?" : formatTokens(Math.max(0, detail.window - detail.reserveTokens - detail.used));
	const threshold =
		detail.window > 0 ? `${(((detail.window - detail.reserveTokens) / detail.window) * 100).toFixed(0)}%` : "?";
	const cost = `$${detail.cost.toFixed(3)}${detail.subscription ? " (sub)" : ""}`;
	const lines = [
		`${used} / ${formatTokens(detail.window)} tokens (${percent})`,
		detail.model,
		"",
		grid,
		"",
		`Cost            ${cost}`,
		detail.autoCompact ? `Auto-compact    at ${threshold} · ${remaining} remaining` : "Auto-compact    off",
		`Messages        ${detail.messages}`,
		`Tool calls      ${detail.toolCalls}`,
		`Compactions     ${detail.compactions}`,
	];
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

export class ContextUsagePanel implements Component {
	private width = 0;
	private readonly detail: () => ContextDetail;
	private readonly onClose: () => void;

	constructor(detail: () => ContextDetail, onClose: () => void) {
		this.detail = detail;
		this.onClose = onClose;
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.width = width;
		const inner = Math.max(1, width - 4);
		return popupFrame("Context", contextPanelLines(this.detail(), inner), width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") this.onClose();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!popupCloseClicked(event, this.width)) return undefined;
		this.onClose();
		return { handled: true };
	}
}

/** The one line fixed above the transcript. */
export class SessionTopBar implements Component {
	private readonly footer: FooterComponent;
	private readonly onDashboardClick: () => void;
	private readonly onContextClick: () => void;

	constructor(footer: FooterComponent, onDashboardClick: () => void, onContextClick: () => void) {
		this.footer = footer;
		this.onDashboardClick = onDashboardClick;
		this.onContextClick = onContextClick;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.footer.renderTopBar(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.y !== 0) return undefined;
		const context = this.footer.contextHitRange();
		const overContext = context !== undefined && event.x >= context.start && event.x < context.end;
		if (event.type === "move") {
			const hover = Boolean(overContext);
			if (hover === this.footer.contextHovering()) return { handled: true, render: false };
			this.footer.setContextHover(hover);
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (overContext) {
			this.onContextClick();
			return { handled: true };
		}
		const hit = this.footer.dashboardHitRange();
		if (!hit || event.x < hit.start || event.x >= hit.end) return undefined;
		this.onDashboardClick();
		return { handled: true };
	}
}
