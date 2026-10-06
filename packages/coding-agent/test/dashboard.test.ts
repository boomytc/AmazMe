import { stripVTControlCharacters } from "node:util";
import { type TuiMouseEvent, visibleWidth } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import {
	type DashboardAgent,
	type DashboardEffect,
	DashboardView,
	defaultDashboardState,
	pressDashboard,
	readDashboardPrefs,
	renderDashboard,
} from "../src/modes/interactive/dashboard.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const NOW = 1_700_000_000_000;

function agent(id: string, patch: Partial<DashboardAgent> = {}): DashboardAgent {
	return {
		id,
		name: id,
		cwd: "/repo",
		state: "idle",
		activity: "idle",
		updatedAt: NOW - 60_000,
		attached: false,
		peek: "",
		...patch,
	};
}

function effects(agents: DashboardAgent[], keys: string[]): DashboardEffect[] {
	const state = defaultDashboardState();
	const seen: DashboardEffect[] = [];
	for (const key of keys) seen.push(pressDashboard(state, agents, key, NOW));
	return seen;
}

function viewFor(agentsOf: () => readonly DashboardAgent[], seen: string[] = []): DashboardView {
	return new DashboardView(
		{
			exit: () => seen.push("exit"),
			create: () => seen.push("create"),
			openPrevious: () => seen.push("previous"),
			open: (id) => seen.push(`open:${id}`),
			dispatch: (text) => seen.push(`dispatch:${text}`),
			reply: (id, text) => seen.push(`reply:${id}:${text}`),
			rename: (id, name) => seen.push(`rename:${id}:${name}`),
			stop: (id) => seen.push(`stop:${id}`),
			delete: (id) => seen.push(`delete:${id}`),
			status: (text) => seen.push(`status:${text}`),
			prefs: () => seen.push("prefs"),
			opened: (open) => seen.push(open ? "opened" : "closed"),
		},
		agentsOf,
		() => ({ branch: "main", cwd: "~/repo" }),
		undefined,
		() => NOW,
	);
}

function mouse(type: "move" | "click", x: number, y: number): TuiMouseEvent {
	return {
		type,
		button: type === "click" ? "left" : "none",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

describe("agent dashboard", () => {
	beforeAll(() => initTheme("dark"));

	test("opens on the roster, peeks a row, and steps back out", () => {
		const agents = [
			agent("live", { name: "reviewer", state: "working", activity: "Responding…", attached: true, peek: "looking" }),
			agent("old", { name: "housekeeping", updatedAt: NOW - 3_600_000 }),
		];
		const state = defaultDashboardState();
		expect(pressDashboard(state, agents, "\x1c", NOW).type).toBe("none");
		expect(state.open).toBe(true);
		expect(state.focus).toBe("list");
		let rendered = renderDashboard(agents, state, { branch: "main", cwd: "~/repo" }, NOW, 80).join("\n");
		expect(rendered).toContain("main ~/repo");
		expect(rendered).toContain("1 working");
		expect(rendered).toContain("1 idle");
		expect(rendered).toContain("+ New session");
		expect(rendered).toContain("Open Previous /resume");
		expect(rendered).toContain("reviewer");
		expect(rendered).toContain("1m");

		pressDashboard(state, agents, "\x1b[B", NOW);
		pressDashboard(state, agents, "\x1b[B", NOW);
		rendered = renderDashboard(agents, state, { branch: "main", cwd: "~/repo" }, NOW, 80).join("\n");
		expect(rendered).toContain("looking");
		expect(state.selected).toBe("row:live");

		expect(pressDashboard(state, agents, "\x1b", NOW).type).toBe("none");
		expect(state.selected).toBe("actions");
		expect(pressDashboard(state, agents, "\x1b", NOW)).toEqual({ type: "exit" });
		expect(state.open).toBe(false);
	});

	test("dispatches, searches, groups, pins, and confirms delete", () => {
		const agents = [
			agent("live", { state: "working", activity: "Responding…", attached: true }),
			agent("idle-one", { cwd: "/repo/a" }),
			...Array.from({ length: 9 }, (_unused, index) =>
				agent(`idle-${index}`, { cwd: "/repo/b", updatedAt: NOW - 2 * 60 * 60 * 1000 }),
			),
		];
		const state = defaultDashboardState();
		pressDashboard(state, agents, "\x1c", NOW);
		const folded = renderDashboard(agents, state, { branch: null, cwd: "~/repo" }, NOW, 100).join("\n");
		expect(folded).toContain("more");

		for (const character of "fix login") pressDashboard(state, agents, character, NOW);
		expect(pressDashboard(state, agents, "\r", NOW)).toEqual({ type: "dispatch", text: "fix login", attach: false });
		expect(state.draft).toBe("");
		state.draft = "stay here";
		expect(pressDashboard(state, agents, "\x13", NOW)).toEqual({ type: "dispatch", text: "stay here", attach: true });

		pressDashboard(state, agents, "\x1f", NOW);
		expect(state.search).toBe(true);
		for (const character of "housekeeping") pressDashboard(state, agents, character, NOW);
		pressDashboard(state, agents, "\x1b[B", NOW);
		expect(state.query).toContain("housekeeping");
		pressDashboard(state, agents, "\x1b", NOW);
		expect(state.search).toBe(false);
		expect(state.filter).toBe("");

		const grouped = pressDashboard(state, agents, "\x07", NOW);
		expect(grouped).toEqual({ type: "prefs" });
		expect(state.grouping).toBe("directory");
		expect(renderDashboard(agents, state, { branch: null, cwd: "~/repo" }, NOW, 80).join("\n")).toContain("/repo");

		pressDashboard(state, agents, "\x1b[B", NOW);
		pressDashboard(state, agents, "\x1b[B", NOW);
		expect(state.selected.startsWith("row:")).toBe(true);
		expect(pressDashboard(state, agents, "\x14", NOW)).toEqual({ type: "prefs" });
		expect(state.pinned).toEqual([state.selected.slice(4)]);

		const idle = agent("gone", { state: "idle", activity: "idle" });
		const idleState = defaultDashboardState();
		pressDashboard(idleState, [idle], "\x1c", NOW);
		pressDashboard(idleState, [idle], "\x1b[B", NOW);
		pressDashboard(idleState, [idle], "\x1b[B", NOW);
		expect(pressDashboard(idleState, [idle], "\x18", NOW)).toEqual({
			type: "status",
			text: "Press Ctrl+X again to delete this session",
		});
		expect(pressDashboard(idleState, [idle], "\x18", NOW)).toEqual({ type: "delete", id: "gone" });

		const working = defaultDashboardState();
		pressDashboard(working, [agent("live", { state: "working", attached: true })], "\x1c", NOW);
		pressDashboard(working, [agent("live", { state: "working", attached: true })], "\x1b[B", NOW);
		pressDashboard(working, [agent("live", { state: "working", attached: true })], "\x1b[B", NOW);
		expect(pressDashboard(working, [agent("live", { state: "working", attached: true })], "\x18", NOW)).toEqual({
			type: "stop",
			id: "live",
		});
	});

	test("the view consumes ctrl+backslash and leaves other keys alone while closed", () => {
		const seen: string[] = [];
		const view = viewFor(() => [agent("live", { state: "working", attached: true, peek: "hello" })], seen);
		expect(view.handleKey("\r")).toBe(false);
		expect(view.handleKey("\x1c")).toBe(true);
		expect(view.isOpen()).toBe(true);
		expect(seen).toEqual(["opened"]);
		expect(view.render(80).join("\n")).toContain("live");
		expect(readDashboardPrefs('{"grouping":"directory","pinned":["live"]}')).toEqual({
			grouping: "directory",
			pinned: ["live"],
		});
	});

	test.each(["dark", "light"] as const)("highlights only the current session in the %s theme", (themeName) => {
		initTheme(themeName);
		try {
			const agents = [
				agent("live", { name: "当前会话", cwd: "/repo/中文", attached: true, peek: "live preview" }),
				agent("saved", { name: "另一会话", cwd: "/repo/中文", peek: "saved preview" }),
			];
			const state = defaultDashboardState();
			state.open = true;
			state.hoverId = "saved";
			const background = theme.getBgAnsi("selectedBg");
			for (const width of [16, 40, 80]) {
				for (const selected of ["actions", "row:live", "row:saved", "section:idle"]) {
					state.selected = selected;
					const lines = renderDashboard(agents, state, { branch: "main", cwd: "~/repo" }, NOW, width);
					const liveRow = lines.find((line) => line.includes("当前会话"));
					const savedRow = lines.findIndex((line) => line.includes("另一"));
					expect(liveRow).toContain(background);
					expect(lines[savedRow]).not.toContain(background);
					expect(lines.filter((line) => line.includes(background))).toHaveLength(selected === "row:live" ? 2 : 1);
					if (selected === "row:saved") {
						expect(stripVTControlCharacters(lines[savedRow]!)).toMatch(/^▌/);
						expect(lines[savedRow + 1]).toContain("saved preview");
						expect(lines[savedRow + 1]).not.toContain(background);
					}
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		} finally {
			initTheme("dark");
		}
	});

	test("refreshes the highlighted session from the current attachment, not the action cursor", () => {
		let agents = [agent("live", { attached: true, peek: "live preview" }), agent("saved")];
		const view = viewFor(() => agents);
		view.toggle();
		view.handleKey("\x1b[B");
		view.handleKey("\x1b[B");
		const background = theme.getBgAnsi("selectedBg");
		expect(view.render(80).filter((line) => line.includes(background))).toHaveLength(2);

		agents = agents.map((item) => ({ ...item, attached: item.id === "saved" }));
		const lines = view.render(80);
		expect(lines.find((line) => line.includes("live ·"))).not.toContain(background);
		expect(lines.find((line) => line.includes("live preview"))).not.toContain(background);
		expect(lines.find((line) => line.includes("saved ·"))).toContain(background);
		expect(lines.filter((line) => line.includes(background))).toHaveLength(1);

		agents = agents.map((item) => ({ ...item, attached: false }));
		expect(view.render(80).filter((line) => line.includes(background))).toEqual([]);
	});

	test("hover reveals only the close badge without changing preview, reply, or rename targets", () => {
		const seen: string[] = [];
		const agents = [agent("live", { attached: true, peek: "live preview" }), agent("saved", { peek: "saved preview" })];
		const view = viewFor(() => agents, seen);
		view.toggle();
		view.handleKey("\x1b[B");
		view.handleKey("\x1b[B");
		view.handleKey("h");
		view.handleKey("i");
		const before = view.render(80);
		const row = before.findIndex((line) => line.includes("saved ·"));
		expect(row).toBeGreaterThan(0);
		expect(view.handleMouse(mouse("move", 2, row))).toEqual({ handled: true, render: true });
		const hovered = view.render(80);
		expect(hovered).toHaveLength(before.length);
		expect(hovered[row]).toContain("[x]");
		expect(hovered[row]).not.toContain(theme.getBgAnsi("selectedBg"));
		expect(hovered.join("\n")).not.toContain("saved preview");
		expect(hovered.filter((line) => line.includes(theme.getBgAnsi("selectedBg")))).toEqual(
			before.filter((line) => line.includes(theme.getBgAnsi("selectedBg"))),
		);
		expect(view.handleMouse(mouse("move", 2, row))).toEqual({ handled: true, render: false });
		view.handleMouse(mouse("move", 2, 0));
		expect(view.render(80)).toEqual(before);
		view.handleKey("\r");
		expect(seen).toEqual(["opened", "reply:live:hi"]);

		view.handleMouse(mouse("move", 2, row));
		view.handleKey("\x12");
		expect(view.render(80).join("\n")).toContain("Rename: live");
		view.handleKey("\r");
		expect(seen.at(-1)).toBe("rename:live:live");
	});

	test("click opens a session and the close badge takes two clicks", () => {
		const seen: string[] = [];
		const saved = agent("saved", { name: "notes", peek: "hello notes", cwd: "/repo/notes" });
		const view = viewFor(() => [agent("live", { attached: true }), saved], seen);
		view.toggle();
		let lines = view.render(80);
		const row = lines.findIndex((line) => line.includes("notes"));
		expect(row).toBeGreaterThan(0);
		view.handleMouse(mouse("move", 2, row));
		lines = view.render(80);
		expect(lines[row] ?? "").toContain("[x]");
		expect(lines.join("\n")).not.toContain("hello notes");
		view.handleMouse(mouse("click", 2, row));
		expect(seen).toContain("open:saved");
		lines = view.render(80);
		expect(lines[row + 1] ?? "").toContain("hello notes");
		expect(lines[row]).not.toContain(theme.getBgAnsi("selectedBg"));
		expect(lines[row + 1]).not.toContain(theme.getBgAnsi("selectedBg"));
		view.handleMouse(mouse("click", 78, row));
		expect(seen).not.toContain("delete:saved");
		expect(view.render(80).join("\n")).toContain("再点一次关闭");
		view.handleMouse(mouse("click", 78, row));
		expect(seen).toContain("delete:saved");
	});

	test("records the same outcomes on a second pass", () => {
		const agents = [agent("live", { state: "working", attached: true })];
		expect(effects(agents, ["\x1c", "\r"]).map((effect) => effect.type)).toEqual(["none", "create"]);
		expect(effects(agents, ["\x1c", "\r"]).map((effect) => effect.type)).toEqual(["none", "create"]);
	});
});
