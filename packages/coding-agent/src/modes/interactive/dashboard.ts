import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	ScrollView,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	VStack,
} from "@amazme/tui";
import { theme } from "./theme/theme.ts";

export type DashboardRowState = "needs-input" | "working" | "idle" | "inactive" | "completed" | "failed";

export interface DashboardAgent {
	id: string;
	name: string;
	cwd: string;
	state: DashboardRowState;
	activity: string;
	updatedAt: number;
	attached: boolean;
	lastQuestion: string;
	path?: string;
}

export interface DashboardPrefs {
	grouping: "state" | "directory";
	pinned: string[];
}

export interface DashboardPlace {
	branch: string | null;
	cwd: string;
}

type Slot =
	| { kind: "actions" }
	| { kind: "section"; key: string; title: string; count: number; collapsed: boolean }
	| { kind: "row"; agentId: string }
	| { kind: "more"; count: number };

export interface DashboardScreenState {
	open: boolean;
	focus: "list" | "input";
	column: 0 | 1;
	selected: string;
	grouping: "state" | "directory";
	search: boolean;
	query: string;
	filter: string;
	draft: string;
	reply: string;
	help: boolean;
	idleExpanded: boolean;
	collapsed: string[];
	pinned: string[];
	renameFor?: string;
	renameText: string;
	deleteArmedFor?: string;
	deleteArmedAt?: number;
	notice?: string;
	hoverId?: string;
}

export interface DashboardHit {
	line: number;
	kind: "new" | "previous" | "section" | "more" | "row";
	id?: string;
	start?: number;
	end?: number;
	closeStart?: number;
	closeEnd?: number;
	renameStart?: number;
	renameEnd?: number;
}

export type DashboardEffect =
	| { type: "none" }
	| { type: "exit" }
	| { type: "create" }
	| { type: "open-previous" }
	| { type: "open"; id: string; attach: boolean }
	| { type: "dispatch"; text: string; attach: boolean }
	| { type: "reply"; id: string; text: string; attach: boolean }
	| { type: "rename"; id: string; name: string }
	| { type: "status"; text: string }
	| { type: "stop"; id: string }
	| { type: "delete"; id: string }
	| { type: "prefs" };

const STATE_ORDER: DashboardRowState[] = ["needs-input", "working", "idle", "inactive", "completed", "failed"];
const STATE_TITLE: Record<DashboardRowState, string> = {
	"needs-input": "Needs input",
	working: "Working",
	idle: "Idle",
	inactive: "Inactive",
	completed: "Completed",
	failed: "Failed",
};
const PROMPT_LIMIT = 64 * 1024;
const IDLE_KEEP = 8;
const IDLE_WINDOW_MS = 60 * 60 * 1000;
const DELETE_WINDOW_MS = 2000;

export function defaultDashboardState(prefs?: Partial<DashboardPrefs>): DashboardScreenState {
	return {
		open: false,
		focus: "list",
		column: 0,
		selected: "actions",
		grouping: prefs?.grouping === "directory" ? "directory" : "state",
		search: false,
		query: "",
		filter: "",
		draft: "",
		reply: "",
		help: false,
		idleExpanded: false,
		collapsed: ["inactive"],
		pinned: [...(prefs?.pinned ?? [])],
		renameText: "",
	};
}

export function readDashboardPrefs(text: string | undefined): DashboardPrefs {
	if (!text) return { grouping: "state", pinned: [] };
	try {
		const parsed = JSON.parse(text) as { grouping?: unknown; pinned?: unknown };
		const grouping = parsed.grouping === "directory" ? "directory" : "state";
		const pinned = Array.isArray(parsed.pinned)
			? parsed.pinned.filter((id): id is string => typeof id === "string" && id.length > 0)
			: [];
		return { grouping, pinned };
	} catch {
		return { grouping: "state", pinned: [] };
	}
}

export function serializeDashboardPrefs(state: Pick<DashboardScreenState, "grouping" | "pinned">): string {
	return `${JSON.stringify({ grouping: state.grouping, pinned: state.pinned }, null, "\t")}\n`;
}

export function formatDashboardAge(ageMs: number): string {
	const minutes = Math.max(0, Math.floor(ageMs / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function dashboardShortcutLine(): string {
	return "↑/↓ select · Enter open · Ctrl+R rename · Ctrl+T pin · Ctrl+X stop · ? help · Esc new";
}

function activeQuery(state: DashboardScreenState): string {
	return (state.search ? state.query : state.filter).trim();
}

function stateSynonym(token: string): DashboardRowState | undefined {
	const names: Record<string, DashboardRowState> = {
		working: "working",
		busy: "working",
		running: "working",
		idle: "idle",
		completed: "completed",
		done: "completed",
		failed: "failed",
		"needs-input": "needs-input",
		awaiting: "needs-input",
		inactive: "inactive",
	};
	return names[token];
}

function matchesAgent(agent: DashboardAgent, query: string): boolean {
	if (query.length === 0) return true;
	const lower = query.toLowerCase();
	if (lower.startsWith("a:")) return agent.name.toLowerCase().includes(lower.slice(2).trim());
	if (lower.startsWith("s:")) {
		const wanted = stateSynonym(lower.slice(2).trim());
		return wanted !== undefined && agent.state === wanted;
	}
	if (lower.startsWith("#")) return agent.name.toLowerCase().includes(`#${lower.slice(1)}`);
	return `${agent.name} ${agent.lastQuestion} ${agent.cwd} ${agent.activity}`.toLowerCase().includes(lower);
}

function slotId(slot: Slot): string {
	if (slot.kind === "actions") return "actions";
	if (slot.kind === "section") return `section:${slot.key}`;
	if (slot.kind === "row") return `row:${slot.agentId}`;
	return "more-idle";
}

export function dashboardSlots(agents: readonly DashboardAgent[], state: DashboardScreenState, now: number): Slot[] {
	const query = activeQuery(state);
	const filtering = query.length > 0;
	const matched = agents.filter((agent) => matchesAgent(agent, query));
	const pinnedIds = new Set(state.pinned);
	const pinned = state.pinned
		.map((id) => matched.find((agent) => agent.id === id))
		.filter((agent): agent is DashboardAgent => agent !== undefined);
	const rest = matched.filter((agent) => !pinnedIds.has(agent.id));
	const slots: Slot[] = [{ kind: "actions" }];
	for (const agent of pinned) slots.push({ kind: "row", agentId: agent.id });

	const groups = new Map<string, DashboardAgent[]>();
	for (const agent of rest) {
		const key = state.grouping === "directory" ? agent.cwd || "." : agent.state;
		const list = groups.get(key);
		if (list) list.push(agent);
		else groups.set(key, [agent]);
	}
	const keys =
		state.grouping === "directory"
			? [...groups.keys()].sort((a, b) => a.localeCompare(b))
			: STATE_ORDER.filter((key) => groups.has(key));
	for (const key of keys) {
		const rows = groups.get(key) ?? [];
		const title = state.grouping === "directory" ? key : STATE_TITLE[key as DashboardRowState];
		const collapsed = state.collapsed.includes(key);
		slots.push({ kind: "section", key, title, count: rows.length, collapsed });
		if (collapsed) continue;
		let visible = rows;
		if (key === "idle" && !filtering && !state.idleExpanded) {
			const fresh = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
			const kept = new Set(
				fresh.filter((agent, index) => agent.attached || index < IDLE_KEEP || now - agent.updatedAt <= IDLE_WINDOW_MS).map((agent) => agent.id),
			);
			visible = rows.filter((agent) => kept.has(agent.id));
			const hidden = rows.length - visible.length;
			for (const agent of visible) slots.push({ kind: "row", agentId: agent.id });
			if (hidden > 0) slots.push({ kind: "more", count: hidden });
			continue;
		}
		for (const agent of visible) slots.push({ kind: "row", agentId: agent.id });
	}
	return slots;
}

function clampSelection(state: DashboardScreenState, slots: readonly Slot[]): void {
	if (!slots.some((slot) => slotId(slot) === state.selected)) state.selected = "actions";
}

function move(state: DashboardScreenState, slots: readonly Slot[], delta: number): void {
	const ids = slots.map(slotId);
	const current = Math.max(0, ids.indexOf(state.selected));
	const next = ids[Math.max(0, Math.min(ids.length - 1, current + delta))] ?? "actions";
	state.selected = next;
	if (next !== "actions") state.column = 0;
	state.reply = "";
}

function selectedAgent(agents: readonly DashboardAgent[], state: DashboardScreenState): DashboardAgent | undefined {
	if (!state.selected.startsWith("row:")) return undefined;
	const id = state.selected.slice(4);
	return agents.find((agent) => agent.id === id);
}

function field(state: DashboardScreenState): "query" | "rename" | "reply" | "draft" {
	if (state.search) return "query";
	if (state.renameFor) return "rename";
	if (state.selected.startsWith("row:")) return "reply";
	return "draft";
}

function fieldText(state: DashboardScreenState): string {
	const which = field(state);
	if (which === "query") return state.query;
	if (which === "rename") return state.renameText;
	if (which === "reply") return state.reply;
	return state.draft;
}

function setField(state: DashboardScreenState, text: string): void {
	const which = field(state);
	if (which === "query") state.query = text;
	else if (which === "rename") state.renameText = text;
	else if (which === "reply") state.reply = text;
	else state.draft = text;
}

function clearArm(state: DashboardScreenState): void {
	state.deleteArmedFor = undefined;
	state.deleteArmedAt = undefined;
}

export function pressDashboard(
	state: DashboardScreenState,
	agents: readonly DashboardAgent[],
	data: string,
	now: number,
): DashboardEffect {
	state.notice = undefined;
	const slots = dashboardSlots(agents, state, now);
	clampSelection(state, slots);
	const armed = state.deleteArmedFor;
	const consumeArm = () => {
		if (armed !== undefined && !matchesKey(data, "ctrl+x")) clearArm(state);
	};

	if (matchesKey(data, "ctrl+\\")) {
		state.open = !state.open;
		if (state.open) {
			state.focus = agents.length > 0 ? "list" : "input";
			state.selected = "actions";
			state.column = 0;
		}
		return state.open ? { type: "none" } : { type: "exit" };
	}
	if (!state.open) return { type: "none" };

	if (state.help && !matchesKey(data, "escape") && !matchesKey(data, "?")) {
		consumeArm();
	}
	if (matchesKey(data, "escape")) {
		if (state.renameFor) {
			state.renameFor = undefined;
			state.renameText = "";
			state.focus = "list";
			return { type: "none" };
		}
		if (state.help) {
			state.help = false;
			return { type: "none" };
		}
		if (state.search) {
			state.search = false;
			state.query = "";
			state.filter = "";
			return { type: "none" };
		}
		if (state.reply.length > 0) {
			state.reply = "";
			return { type: "none" };
		}
		if (state.focus === "input") {
			state.focus = "list";
			return { type: "none" };
		}
		if (state.selected !== "actions" || state.column !== 0) {
			state.selected = "actions";
			state.column = 0;
			return { type: "none" };
		}
		state.open = false;
		return { type: "exit" };
	}
	if (matchesKey(data, "tab")) {
		state.focus = state.focus === "list" ? "input" : "list";
		consumeArm();
		return { type: "none" };
	}
	if (matchesKey(data, "ctrl+/") || data === "\x1f") {
		state.search = !state.search;
		if (!state.search) state.query = "";
		state.focus = "input";
		consumeArm();
		return { type: "none" };
	}
	if (matchesKey(data, "ctrl+g")) {
		state.grouping = state.grouping === "state" ? "directory" : "state";
		consumeArm();
		return { type: "prefs" };
	}
	if (matchesKey(data, "?") && (state.focus === "list" || fieldText(state).length === 0)) {
		state.help = !state.help;
		consumeArm();
		return { type: "none" };
	}

	const listNav = state.focus === "list" || state.search || fieldText(state).length === 0;
	if (listNav && (matchesKey(data, "up") || (state.focus === "list" && data === "k"))) {
		move(state, slots, -1);
		consumeArm();
		return { type: "none" };
	}
	if (listNav && (matchesKey(data, "down") || (state.focus === "list" && data === "j"))) {
		move(state, slots, 1);
		consumeArm();
		return { type: "none" };
	}
	if ((state.focus === "list" || fieldText(state).length === 0) && matchesKey(data, "left")) {
		if (state.selected === "actions") state.column = 0;
		else if (state.selected.startsWith("section:")) {
			const key = state.selected.slice("section:".length);
			if (!state.collapsed.includes(key)) state.collapsed.push(key);
		} else if (state.selected === "more-idle") state.idleExpanded = false;
		consumeArm();
		return { type: "none" };
	}
	if ((state.focus === "list" || fieldText(state).length === 0) && matchesKey(data, "right")) {
		if (state.selected === "actions") state.column = 1;
		else if (state.selected.startsWith("section:")) {
			const key = state.selected.slice("section:".length);
			state.collapsed = state.collapsed.filter((item) => item !== key);
		} else if (state.selected === "more-idle") state.idleExpanded = true;
		consumeArm();
		return { type: "none" };
	}

	if (matchesKey(data, "ctrl+r")) {
		const agent = selectedAgent(agents, state);
		if (!agent) return status(state, "Select an agent to rename");
		state.renameFor = agent.id;
		state.renameText = singleLine(agent.name);
		state.focus = "input";
		state.help = false;
		consumeArm();
		return { type: "none" };
	}
	if (matchesKey(data, "ctrl+t")) {
		const agent = selectedAgent(agents, state);
		if (!agent) return status(state, "Select an agent to pin");
		state.pinned = state.pinned.includes(agent.id)
			? state.pinned.filter((id) => id !== agent.id)
			: [...state.pinned, agent.id];
		consumeArm();
		return { type: "prefs" };
	}
	if (matchesKey(data, "ctrl+x")) {
		const agent = selectedAgent(agents, state);
		if (!agent) return status(state, "Select an agent first");
		if (agent.state === "working") {
			clearArm(state);
			return { type: "stop", id: agent.id };
		}
		if (state.deleteArmedFor === agent.id && state.deleteArmedAt !== undefined && now - state.deleteArmedAt <= DELETE_WINDOW_MS) {
			clearArm(state);
			return { type: "delete", id: agent.id };
		}
		state.deleteArmedFor = agent.id;
		state.deleteArmedAt = now;
		return status(state, "Press Ctrl+X again to delete this session");
	}
	if (matchesKey(data, "ctrl+u")) {
		setField(state, "");
		consumeArm();
		return { type: "none" };
	}

	if (matchesKey(data, "enter") || matchesKey(data, "ctrl+s")) {
		const attach = matchesKey(data, "ctrl+s");
		if (state.renameFor) {
			const name = state.renameText.trim();
			const id = state.renameFor;
			state.renameFor = undefined;
			state.renameText = "";
			state.focus = "list";
			if (name.length === 0) return status(state, "Name left unchanged");
			return { type: "rename", id, name };
		}
		if (state.search) {
			state.filter = state.query.trim();
			state.search = false;
			state.focus = "list";
			return { type: "none" };
		}
		if (state.selected === "actions" && state.column === 1) return { type: "open-previous" };
		if (state.selected === "actions") {
			const text = state.draft.trim();
			if (text.length === 0) return { type: "create" };
			if (text.length > PROMPT_LIMIT) return status(state, "Prompt is too long");
			state.draft = "";
			return { type: "dispatch", text, attach };
		}
		if (state.selected.startsWith("section:")) {
			const key = state.selected.slice("section:".length);
			state.collapsed = state.collapsed.includes(key)
				? state.collapsed.filter((item) => item !== key)
				: [...state.collapsed, key];
			return { type: "none" };
		}
		if (state.selected === "more-idle") {
			state.idleExpanded = !state.idleExpanded;
			return { type: "none" };
		}
		const agent = selectedAgent(agents, state);
		if (!agent) return { type: "none" };
		const reply = state.reply.trim();
		if (reply.length === 0) return { type: "open", id: agent.id, attach: true };
		if (reply.length > PROMPT_LIMIT) return status(state, "Prompt is too long");
		state.reply = "";
		return { type: "reply", id: agent.id, text: reply, attach };
	}

	if (matchesKey(data, "shift+enter") || matchesKey(data, "alt+enter")) {
		setField(state, `${fieldText(state)}\n`);
		state.focus = "input";
		consumeArm();
		return { type: "none" };
	}
	if (matchesKey(data, "backspace")) {
		const text = fieldText(state);
		setField(state, text.slice(0, -1));
		consumeArm();
		return { type: "none" };
	}
	if (data.length === 1 && data >= " " && data !== "\x7f") {
		if (state.focus === "list" && (data === "j" || data === "k")) return { type: "none" };
		setField(state, `${fieldText(state)}${data}`);
		state.focus = "input";
		consumeArm();
		return { type: "none" };
	}
	consumeArm();
	return { type: "none" };
}

function status(state: DashboardScreenState, text: string): DashboardEffect {
	state.notice = text;
	return { type: "status", text };
}

function singleLine(text: string): string {
	return stripTerminalSequences(text).replace(/\s+/g, " ").trim();
}

function clip(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), width === 1 && text.startsWith("▌") ? "" : "…");
}

/** Reserve action columns before hover so the title never changes its truncation. */
function sessionRow(
	label: string,
	age: string,
	badge: boolean,
	columns: number,
): { body: string; closeStart?: number; renameStart?: number; renameEnd?: number } {
	const rename = columns >= 56 ? "[rename]" : columns >= 32 ? "[r]" : "";
	const actions = columns >= 20 ? `${rename ? `${rename} ` : ""}[x]` : "";
	const tail = `${columns >= 32 ? `${age} ` : ""}${badge ? actions : " ".repeat(actions.length)}`;
	const room = Math.max(0, columns - visibleWidth(tail) - (tail ? 1 : 0));
	const left = clip(label, room);
	const gap = Math.max(0, columns - visibleWidth(left) - visibleWidth(tail));
	const renameStart = badge && rename ? columns - actions.length : undefined;
	return {
		body: `${left}${" ".repeat(gap)}${tail}`,
		closeStart: badge && actions ? columns - 3 : undefined,
		renameStart,
		renameEnd: renameStart === undefined ? undefined : renameStart + rename.length,
	};
}

function bar(text: string, columns: number, highlighted: boolean): string {
	const padded = text + " ".repeat(Math.max(0, columns - visibleWidth(text)));
	const line = truncateToWidth(padded, columns, "");
	return highlighted ? theme.bg("selectedBg", line) : line;
}

function glyph(state: DashboardRowState): string {
	if (state === "working") return "·";
	if (state === "idle" || state === "inactive") return "○";
	return "●";
}

function dashboardHeader(agents: readonly DashboardAgent[], width: number): string[] {
	const working = agents.filter((agent) => agent.state === "working").length;
	const awaiting = agents.filter((agent) => agent.state === "needs-input").length;
	const idle = agents.filter((agent) => agent.state === "idle").length;
	const title = width < 24 ? "Sessions" : `Sessions ${agents.length}`;
	const variants = [
		[awaiting ? `${awaiting} awaiting` : "", working ? `${working} working` : "", idle ? `${idle} idle` : ""]
			.filter(Boolean).join("  "),
		[awaiting ? `${awaiting} wait` : "", working ? `${working} busy` : ""].filter(Boolean).join("  "),
		awaiting ? `${awaiting} wait` : working ? `${working} busy` : idle ? `${idle} idle` : "",
	];
	const stats = variants.find((text) => text && visibleWidth(title) + 2 + visibleWidth(text) <= width) ?? "";
	const line = title + (stats ? " ".repeat(width - visibleWidth(title) - visibleWidth(stats)) + stats : "");
	return [clip(line, width), ""];
}

function dashboardFooter(state: DashboardScreenState, width: number): string[] {
	let text = state.notice ?? "";
	if (!text && state.renameFor) text = width >= 40 ? "Enter save · Esc cancel · Ctrl+U clear" : "Enter save · Esc cancel";
	else if (!text && state.search) text = `Search: ${state.query}`;
	else if (!text && state.help) text = "↑/↓ move · Enter open · Ctrl+R rename · Ctrl+X close";
	else if (!text && state.filter) text = `Filter: ${state.filter}`;
	else if (!text && state.reply) text = `Reply: ${singleLine(state.reply)}`;
	else if (!text && state.draft) text = `New: ${singleLine(state.draft)}`;
	return [clip(text, width)];
}

function dashboardBody(
	agents: readonly DashboardAgent[],
	state: DashboardScreenState,
	now: number,
	width: number,
	hits?: DashboardHit[],
	renameLine?: string,
	lineOffset = 0,
): string[] {
	const slots = dashboardSlots(agents, state, now);
	clampSelection(state, slots);
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const lines: string[] = [];
	const remember = (hit: DashboardHit) => hits?.push({ start: 0, end: width, ...hit, line: hit.line + lineOffset });
	for (const slot of slots) {
		const id = slotId(slot);
		const selected = id === state.selected;
		if (slot.kind === "actions") {
			const labels = width >= 38
				? ["+ New session", "Open Previous /resume"]
				: width >= 18 ? ["+ New", "Previous"] : ["+", "Prev"];
			const create = `${selected && state.column === 0 ? "▌" : width === 1 ? "" : " "}${labels[0]}`;
			const previous = `${selected && state.column === 1 ? "▌" : width === 1 ? "" : " "}${labels[1]}`;
			const line = lines.length;
			if (visibleWidth(create) + 1 + visibleWidth(previous) <= width) {
				const start = width - visibleWidth(previous);
				lines.push(create + " ".repeat(start - visibleWidth(create)) + previous);
				remember({ line, kind: "new", end: visibleWidth(create) });
				remember({ line, kind: "previous", start });
			} else {
				lines.push(clip(create, width), clip(previous, width));
				remember({ line, kind: "new" });
				remember({ line: line + 1, kind: "previous" });
			}
			continue;
		}
		if (slot.kind === "section") {
			const arrow = slot.collapsed ? "▸" : "▾";
			const prefix = `${selected ? "▌" : " "}${arrow} `;
			const count = ` ${slot.count}`;
			const title = singleLine(slot.title);
			const room = Math.max(0, width - visibleWidth(prefix) - visibleWidth(count));
			const label = state.grouping === "directory" && visibleWidth(title) > room
				? (title.split(/[\\/]/).filter(Boolean).at(-1) ?? title) : title;
			remember({ line: lines.length, kind: "section", id: slot.key });
			lines.push(clip(prefix + clip(label, room) + count, width));
			lines.push(theme.fg("dim", "─".repeat(Math.max(0, width))));
			continue;
		}
		if (slot.kind === "more") {
			remember({ line: lines.length, kind: "more" });
			lines.push(clip(`${selected ? "▌" : " "}${slot.count} more`, width));
			continue;
		}
		const agent = byId.get(slot.agentId);
		if (!agent) continue;
		const age = formatDashboardAge(Math.max(0, now - agent.updatedAt));
		const name = singleLine(agent.name);
		const label = `${selected ? "▌" : " "}${glyph(agent.state)} ${name}`;
		const renaming = state.renameFor === agent.id;
		const badge = state.hoverId === agent.id || state.deleteArmedFor === agent.id;
		const row = sessionRow(label, age, badge, width);
		const line = lines.length;
		// Current-session highlighting is independent of keyboard focus and pointer hover.
		lines.push(bar(renaming ? (renameLine ?? `> ${state.renameText}`) : row.body, width, agent.attached));
		remember({
			line,
			kind: "row",
			id: agent.id,
			closeStart: renaming ? undefined : row.closeStart,
			closeEnd: renaming || row.closeStart === undefined ? undefined : row.closeStart + 3,
			renameStart: renaming ? undefined : row.renameStart,
			renameEnd: renaming ? undefined : row.renameEnd,
		});
		const question = singleLine(agent.lastQuestion);
		lines.push(bar(theme.fg("muted", `  ${question || "No question yet"}`), width, agent.attached));
		remember({ line: lines.length - 1, kind: "row", id: agent.id });
	}
	return lines.map((line) => (line.includes("\x1b") ? line : clip(line, width)));
}

export function renderDashboard(
	agents: readonly DashboardAgent[],
	state: DashboardScreenState,
	_place: DashboardPlace,
	now: number,
	width: number,
	hits?: DashboardHit[],
	renameLine?: string,
): string[] {
	const header = dashboardHeader(agents, width);
	return [
		...header,
		...dashboardBody(agents, state, now, width, hits, renameLine, header.length),
		...dashboardFooter(state, width),
	];
}

/** The layout callback runs after content and viewport sizes are known, before clipping. */
class DashboardScrollView extends ScrollView {
	private readonly revealSelection: (resized: boolean) => void;

	constructor(body: Component, revealSelection: (resized: boolean) => void) {
		super(body, {
			follow: "none", primary: true, overscroll: "contain", scrollbar: "auto",
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		this.revealSelection = revealSelection;
	}

	override getContentWidth(width: number): number {
		return Math.max(1, width - 1);
	}

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		const resized = this.viewportHeight !== viewportHeight;
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		this.revealSelection(resized);
	}
}

export interface DashboardActions {
	exit(): void;
	create(): void;
	openPrevious(): void;
	open(id: string): void;
	dispatch(text: string, attach: boolean): void;
	reply(id: string, text: string, attach: boolean): void;
	rename(id: string, name: string): void;
	stop(id: string): void;
	delete(id: string): void;
	status(text: string): void;
	prefs(state: DashboardScreenState): void;
	opened(open: boolean): void;
	focusInput?(): void;
	focusList?(): void;
}

/** Full-screen agent roster. The transcript hides behind it while `open` is set. */
export class DashboardView implements Component, Focusable {
	focused = false;
	private renameInput?: Input;
	private readonly state: DashboardScreenState;
	private readonly actions: DashboardActions;
	private readonly agentsOf: () => readonly DashboardAgent[];
	private readonly placeOf: () => DashboardPlace;
	private readonly now: () => number;
	private hits: DashboardHit[] = [];
	private revealRequested = true;
	private selectedRange = "";
	readonly scrollView: ScrollView;
	readonly viewport: Component;

	constructor(
		actions: DashboardActions,
		agentsOf: () => readonly DashboardAgent[],
		placeOf: () => DashboardPlace,
		prefs?: Partial<DashboardPrefs>,
		now: () => number = Date.now,
	) {
		this.actions = actions;
		this.agentsOf = agentsOf;
		this.placeOf = placeOf;
		this.state = defaultDashboardState(prefs);
		this.now = now;
		const owner = this;
		const body: Component & Focusable = {
			get focused() {
				return owner.focused;
			},
			set focused(value: boolean) {
				owner.focused = value;
			},
			render: (width) => this.renderBody(width),
			invalidate: () => this.invalidate(),
			handleInput: (data) => this.handleInput(data),
			handleMouse: (event) => this.handleMouse(event),
		};
		this.scrollView = new DashboardScrollView(body, (resized) => this.revealSelection(resized));
		this.viewport = new VStack([
			{
				component: { render: (width) => dashboardHeader(this.agentsOf(), width), invalidate() {} },
				shrink: 1, minSize: 0,
			},
			{ component: this.scrollView, basis: 0, grow: 1, minSize: 1 },
			{
				component: { render: (width) => dashboardFooter(this.state, width), invalidate() {} },
				shrink: 0, minSize: 1,
			},
		]);
	}

	isOpen(): boolean {
		return this.state.open;
	}

	shortcutLine(): string {
		return this.state.renameFor ? "Enter save · Esc cancel · Ctrl+U clear" : dashboardShortcutLine();
	}

	composerShortcutLine(): string {
		const chip = (key: string, action: string) => `\x1b[1m${key}\x1b[22m:${action}`;
		if (this.state.renameFor) return chip("Ctrl+\\", "dashboard");
		let action = "toggle";
		if (this.state.search) action = "filter";
		else if (this.state.selected === "actions") {
			action = this.state.column === 1 ? "previous" : this.state.draft.trim() ? "send" : "create";
		} else if (this.state.selected.startsWith("row:")) action = this.state.reply.trim() ? "reply" : "open";
		return [chip("Enter", action), chip("Tab", this.focused ? "input" : "list")].join(" │ ");
	}

	composerPlaceholder(): string {
		if (this.state.renameFor) return "Editing title above";
		if (this.state.search) return "Search sessions";
		const agent = selectedAgent(this.agentsOf(), this.state);
		return agent ? `Reply to ${singleLine(agent.name)}` : "Start a new session";
	}

	toggle(): void {
		this.press("\x1c");
	}

	forceClose(): void {
		if (!this.state.open) return;
		this.state.open = false;
		this.cancelRename();
		this.actions.opened(false);
	}

	handleInput(data: string): void {
		if (this.state.open && !this.state.renameFor && matchesKey(data, "tab")) {
			this.state.focus = "input";
			this.state.notice = undefined;
			clearArm(this.state);
			this.actions.focusInput?.();
			return;
		}
		this.press(data);
	}

	/** Editor route. Returns true when the dashboard consumed the key. */
	handleKey(data: string): boolean {
		if (!this.state.open && !matchesKey(data, "ctrl+\\")) return false;
		if (this.state.open && !this.state.renameFor && matchesKey(data, "tab")) {
			this.state.focus = "list";
			this.state.notice = undefined;
			clearArm(this.state);
			this.revealRequested = true;
			this.actions.focusList?.();
			return true;
		}
		this.press(data);
		return true;
	}

	invalidate(): void {
		this.revealRequested = true;
	}

	private renderBody(width: number): string[] {
		this.hits = [];
		if (this.renameInput) this.renameInput.focused = this.focused;
		return dashboardBody(
			this.agentsOf(),
			this.state,
			this.now(),
			width,
			this.hits,
			this.renameInput?.render(width)[0],
		).map((line) => theme.fg("text", line));
	}

	private revealSelection(resized: boolean): void {
		const selected = this.state.selected;
		const rows = this.hits.filter((hit) => {
			if (selected === "actions") return hit.kind === (this.state.column === 0 ? "new" : "previous");
			if (selected === "more-idle") return hit.kind === "more";
			return selected === `${hit.kind}:${hit.id}`;
		});
		if (rows.length === 0) return;
		const start = rows[0]!.line;
		const end = rows.at(-1)!.line + 1;
		const range = `${selected}:${start}:${end}`;
		if (!this.revealRequested && !resized && range === this.selectedRange) return;
		this.selectedRange = range;
		this.revealRequested = false;
		const height = this.scrollView.viewportHeight;
		if (height <= 0) return;
		const top = this.scrollView.scrollTop;
		if (start < top) this.scrollView.scrollTo(start);
		else if (end > top + height) this.scrollView.scrollTo(end - start > height ? start : end - height);
	}

	render(width: number): string[] {
		if (!this.state.open) return [];
		this.hits = [];
		if (this.renameInput) this.renameInput.focused = this.focused;
		const renameLine = this.renameInput?.render(width)[0];
		return renderDashboard(this.agentsOf(), this.state, this.placeOf(), this.now(), width, this.hits, renameLine).map(
			(line) => theme.fg("text", line),
		);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.state.open || event.y < 0) return undefined;
		const hit = this.hits.find((item) =>
			item.line === event.y && event.x >= (item.start ?? 0) && event.x < (item.end ?? event.width),
		);
		if (this.renameInput) {
			const title = this.hits.find((item) => item.kind === "row" && item.id === this.state.renameFor);
			if (title?.line === event.y) {
				return this.renameInput.handleMouse({ ...event, y: 0 }) ?? { handled: true, render: false };
			}
			return { handled: true, render: false };
		}
		if (event.type === "move") {
			const next = hit?.kind === "row" ? hit.id : undefined;
			if (next === this.state.hoverId) return { handled: true, render: false };
			this.state.hoverId = next;
			return { handled: true, render: true };
		}
		if (event.type !== "click" || event.button !== "left" || !hit) return undefined;
		if (hit.kind === "new" || hit.kind === "previous") {
			this.state.selected = "actions";
			this.state.column = hit.kind === "new" ? 0 : 1;
			if (hit.kind === "new") this.actions.create();
			else this.actions.openPrevious();
			return { handled: true };
		}
		if (hit.kind === "section" || hit.kind === "more") {
			this.state.selected = hit.kind === "section" ? `section:${hit.id}` : "more-idle";
			if (hit.kind === "section" && hit.id) {
				this.state.collapsed = this.state.collapsed.includes(hit.id)
					? this.state.collapsed.filter((key) => key !== hit.id) : [...this.state.collapsed, hit.id];
			} else this.state.idleExpanded = !this.state.idleExpanded;
			this.state.focus = "list";
			this.state.notice = undefined;
			this.revealRequested = true;
			clearArm(this.state);
			return { handled: true, render: true, focus: true };
		}
		if (hit.kind !== "row" || !hit.id) return undefined;
		if (hit.renameStart !== undefined && hit.renameEnd !== undefined && event.x >= hit.renameStart && event.x < hit.renameEnd) {
			this.state.selected = `row:${hit.id}`;
			this.press("\x12");
			return { handled: true, render: true, focus: true };
		}
		if (hit.closeStart !== undefined && hit.closeEnd !== undefined && event.x >= hit.closeStart && event.x < hit.closeEnd) {
			this.pressClose(hit.id);
			return { handled: true, render: true };
		}
		this.state.selected = `row:${hit.id}`;
		this.actions.open(hit.id);
		return { handled: true };
	}

	private pressClose(id: string): void {
		const agent = this.agentsOf().find((item) => item.id === id);
		if (!agent) return;
		const now = this.now();
		if (
			this.state.deleteArmedFor === id &&
			this.state.deleteArmedAt !== undefined &&
			now - this.state.deleteArmedAt <= 2000
		) {
			this.state.deleteArmedFor = undefined;
			this.state.deleteArmedAt = undefined;
			if (agent.state === "working") this.actions.stop(id);
			else this.actions.delete(id);
			return;
		}
		this.state.deleteArmedFor = id;
		this.state.deleteArmedAt = now;
		this.state.hoverId = id;
		this.state.notice = "再点一次关闭";
	}

	private cancelRename(): void {
		this.renameInput = undefined;
		this.state.renameFor = undefined;
		this.state.renameText = "";
		this.state.focus = "list";
	}

	private startRenameInput(): void {
		const input = new Input({ placeholder: "Session title" });
		input.setValue(this.state.renameText);
		input.onSubmit = (value) => {
			this.state.renameText = value;
			this.renameInput = undefined;
			this.press("\r");
		};
		input.onEscape = () => this.cancelRename();
		this.renameInput = input;
		this.revealRequested = true;
		this.actions.focusList?.();
	}

	private press(data: string): void {
		if (this.renameInput && !matchesKey(data, "ctrl+\\")) {
			if (matchesKey(data, "ctrl+u")) this.renameInput.setValue("");
			else if (matchesKey(data, "ctrl+s")) this.renameInput.onSubmit?.(this.renameInput.getValue());
			else this.renameInput.handleInput(data);
			if (this.renameInput) this.state.renameText = this.renameInput.getValue();
			return;
		}
		const wasOpen = this.state.open;
		const previousSelection = this.state.selected;
		const effect = pressDashboard(this.state, this.agentsOf(), data, this.now());
		if (!wasOpen && this.state.open) {
			const current = this.agentsOf().find((agent) => agent.attached && matchesAgent(agent, activeQuery(this.state)));
			if (current) {
				const key = this.state.grouping === "directory" ? current.cwd || "." : current.state;
				this.state.collapsed = this.state.collapsed.filter((item) => item !== key);
				this.state.selected = `row:${current.id}`;
				this.state.reply = "";
			}
			this.scrollView.scrollToStart();
			this.revealRequested = true;
		}
		if (previousSelection !== this.state.selected || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.revealRequested = true;
		}
		if (!this.state.open) this.cancelRename();
		else if (this.state.renameFor && !this.renameInput) this.startRenameInput();
		if (this.state.open !== wasOpen) this.actions.opened(this.state.open);
		this.apply(effect);
	}

	private apply(effect: DashboardEffect): void {
		switch (effect.type) {
			case "none":
				return;
			case "exit":
				this.actions.exit();
				return;
			case "create":
				this.actions.create();
				return;
			case "open-previous":
				this.actions.openPrevious();
				return;
			case "open":
				this.actions.open(effect.id);
				return;
			case "dispatch":
				this.actions.dispatch(effect.text, effect.attach);
				return;
			case "reply":
				this.actions.reply(effect.id, effect.text, effect.attach);
				return;
			case "rename":
				this.actions.rename(effect.id, effect.name);
				return;
			case "stop":
				this.actions.stop(effect.id);
				return;
			case "delete":
				this.actions.delete(effect.id);
				return;
			case "status":
				this.actions.status(effect.text);
				return;
			case "prefs":
				this.actions.prefs(this.state);
				return;
			default:
				return;
		}
	}
}
