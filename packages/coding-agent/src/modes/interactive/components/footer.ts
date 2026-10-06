import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth } from "@amazme/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

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
		const sessionName = this.session.sessionManager.getSessionName();
		const left = [sessionName, this.placeLabel()].filter((part): part is string => part !== undefined && part.length > 0).join(" • ");
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const used = contextUsage?.tokens === null || contextUsage?.tokens === undefined ? "?" : formatTokens(contextUsage.tokens);
		const contextText = `${used} / ${formatTokens(contextWindow)}`;
		const percent = contextUsage?.percent;
		const context =
			percent !== null && percent !== undefined && percent > 90
				? theme.fg("error", contextText)
				: percent !== null && percent !== undefined && percent > 70
					? theme.fg("warning", contextText)
					: theme.fg("dim", contextText);
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		const cost =
			usageTotals.cost || usingSubscription
				? theme.fg("dim", `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`)
				: "";
		const dashboard = "[Dashboard]";
		const before = [context, cost].filter((part) => part.length > 0).join("  ");
		const right = before.length > 0 ? `${before}  ${theme.fg("accent", dashboard)}` : theme.fg("accent", dashboard);
		const dashboardOffset = visibleWidth(before) + (before.length > 0 ? 2 : 0);
		const leftWidth = visibleWidth(left);
		const rightWidth = visibleWidth(right);
		let rightStart = 0;
		let line: string;
		if (leftWidth + 2 + rightWidth <= width) {
			rightStart = width - rightWidth;
			line = theme.fg("dim", left) + " ".repeat(width - leftWidth - rightWidth) + right;
		} else if (rightWidth <= width) {
			rightStart = width - rightWidth;
			line = " ".repeat(width - rightWidth) + right;
		} else {
			rightStart = 0;
			line = truncateToWidth(right, width, "");
		}
		const start = rightStart + dashboardOffset;
		this.dashboardHit = start >= 0 && start + dashboard.length <= width ? { start, end: start + dashboard.length } : undefined;
		return [line];
	}

	dashboardHitRange(): { start: number; end: number } | undefined {
		return this.dashboardHit;
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
		const lines = visibleWidth(statsLineRendered) > 0 ? [pwdLine, statsLineRendered] : [pwdLine];
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

/** The one line fixed above the transcript. */
export class SessionTopBar implements Component {
	private readonly footer: FooterComponent;
	private readonly onDashboardClick: () => void;

	constructor(footer: FooterComponent, onDashboardClick: () => void) {
		this.footer = footer;
		this.onDashboardClick = onDashboardClick;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.footer.renderTopBar(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		const hit = this.footer.dashboardHitRange();
		if (!hit || event.x < hit.start || event.x >= hit.end) return undefined;
		this.onDashboardClick();
		return { handled: true };
	}
}
