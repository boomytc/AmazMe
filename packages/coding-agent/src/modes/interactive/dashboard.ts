import type { Component } from "@amazme/tui";
import { matchesKey } from "@amazme/tui";
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
	peek: string;
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

export function dashboardPeek(
	messages: readonly { role: string; content?: unknown; command?: string; output?: string }[],
): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "bashExecution") {
			const output = message.output?.trim();
			if (output) return output;
			if (message.command) return message.command;
		}
		if (message.role !== "assistant" && message.role !== "user") continue;
		const text = dashboardContentText(message.content).trim();
		if (text.length > 0) return text;
	}
	return "";
}

function dashboardContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const record = part as { type?: unknown; text?: unknown };
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

export function formatDashboardAge(ageMs: number): string {
	const minutes = Math.max(0, Math.floor(ageMs / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function dashboardShortcutLine(): string {
	return "↑/↓ select (peek) · Enter open · Ctrl+R rename · Ctrl+T pin · Ctrl+X stop · ? help · Esc new";
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
	return `${agent.name} ${agent.cwd} ${agent.activity}`.toLowerCase().includes(lower);
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
				fresh.filter((agent, index) => index < IDLE_KEEP || now - agent.updatedAt <= IDLE_WINDOW_MS).map((agent) => agent.id),
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
		if (state.renameFor) {
			state.renameFor = undefined;
			state.renameText = "";
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
		state.renameText = agent.name;
		state.focus = "input";
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

function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

function glyph(state: DashboardRowState): string {
	if (state === "working") return "·";
	if (state === "idle" || state === "inactive") return "○";
	return "●";
}

export function renderDashboard(
	agents: readonly DashboardAgent[],
	state: DashboardScreenState,
	place: DashboardPlace,
	now: number,
	width: number,
): string[] {
	const slots = dashboardSlots(agents, state, now);
	clampSelection(state, slots);
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const counts = { "needs-input": 0, working: 0, idle: 0 };
	for (const agent of agents) {
		if (agent.state === "needs-input" || agent.state === "working" || agent.state === "idle") counts[agent.state] += 1;
	}
	const where = [place.branch, place.cwd].filter((part): part is string => part !== null && part.length > 0).join(" ");
	const chips = `◆ ${counts["needs-input"]} awaiting │ ⋮ ${counts.working} working │ ◇ ${counts.idle} idle`;
	const lines = [clip(`${where}  ${chips}`, width), ""];
	for (const slot of slots) {
		const id = slotId(slot);
		const mark = id === state.selected ? "▌" : " ";
		if (slot.kind === "actions") {
			const create = state.column === 0 && id === state.selected ? "▌+ New Agent" : " + New Agent";
			const previous = state.column === 1 && id === state.selected ? "▌Open Previous /resume" : " Open Previous /resume";
			const gap = Math.max(1, width - create.length - previous.length);
			lines.push(clip(`${create}${" ".repeat(gap)}${previous}`, width));
			continue;
		}
		if (slot.kind === "section") {
			const arrow = slot.collapsed ? "▸" : "▾";
			lines.push(clip(`${mark}${arrow} ${slot.title} (${slot.count})`, width));
			continue;
		}
		if (slot.kind === "more") {
			lines.push(clip(`${mark}${slot.count} more`, width));
			continue;
		}
		const agent = byId.get(slot.agentId);
		if (!agent) continue;
		const age = formatDashboardAge(Math.max(0, now - agent.updatedAt));
		const label = `${glyph(agent.state)} ${agent.name}`;
		const right = `${agent.activity}  ${age}`;
		const gap = Math.max(1, width - mark.length - label.length - right.length);
		lines.push(clip(`${mark}${label}${" ".repeat(gap)}${right}`, width));
	}
	lines.push("");
	if (state.help) {
		lines.push("↑/↓ move  Enter open  Ctrl+S send and attach  Ctrl+/ search  Ctrl+G group");
		lines.push("Ctrl+R rename  Ctrl+T pin  Ctrl+X stop or delete  Esc step back  Ctrl+\\ close");
		return lines.map((line) => clip(line, width));
	}
	const agent = selectedAgent(agents, state);
	if (state.renameFor) {
		lines.push("╭ rename");
		lines.push(clip(`│ ${state.renameText}`, width));
		lines.push("╰ enter to save");
	} else if (state.search) {
		lines.push("╭ search");
		lines.push(clip(`│ Search: ${state.query}`, width));
		lines.push("╰ enter keeps the filter");
	} else if (agent) {
		const preview = agent.peek.replace(/\s+/g, " ").trim();
		lines.push(clip(`${agent.activity}  ${formatDashboardAge(Math.max(0, now - agent.updatedAt))}`, width));
		lines.push(clip(preview.length > 0 ? preview : "No response yet", width));
		lines.push(clip(`❯ ${state.reply.length > 0 ? state.reply.replace(/\n/g, "⏎") : "reply"}`, width));
	} else {
		lines.push("╭ dispatch");
		lines.push(clip(`│ ❯ ${state.draft.length > 0 ? state.draft.replace(/\n/g, "⏎") : "Dispatch a new agent"}`, width));
		lines.push("╰ dispatch");
	}
	if (state.notice) lines.push(clip(state.notice, width));
	lines.push(dashboardShortcutLine());
	return lines.map((line) => clip(line, width));
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
}

/** Full-screen agent roster. The transcript hides behind it while `open` is set. */
export class DashboardView implements Component {
	private readonly state: DashboardScreenState;
	private readonly actions: DashboardActions;
	private readonly agentsOf: () => readonly DashboardAgent[];
	private readonly placeOf: () => DashboardPlace;
	private readonly now: () => number;

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
	}

	isOpen(): boolean {
		return this.state.open;
	}

	shortcutLine(): string {
		return dashboardShortcutLine();
	}

	toggle(): void {
		this.press("\x1c");
	}

	forceClose(): void {
		if (!this.state.open) return;
		this.state.open = false;
		this.actions.opened(false);
	}

	handleInput(data: string): void {
		this.press(data);
	}

	/** Editor route. Returns true when the dashboard consumed the key. */
	handleKey(data: string): boolean {
		if (!this.state.open && !matchesKey(data, "ctrl+\\")) return false;
		this.press(data);
		return true;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.state.open) return [];
		return renderDashboard(this.agentsOf(), this.state, this.placeOf(), this.now(), width).map((line) =>
			theme.fg("text", line),
		);
	}

	private press(data: string): void {
		const wasOpen = this.state.open;
		const effect = pressDashboard(this.state, this.agentsOf(), data, this.now());
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
