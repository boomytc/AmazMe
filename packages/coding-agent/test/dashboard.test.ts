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
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

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
		expect(rendered).toContain("+ New Agent");
		expect(rendered).toContain("Open Previous /resume");
		expect(rendered).toContain("reviewer");
		expect(rendered).toContain("Responding…");

		pressDashboard(state, agents, "\x1b[B", NOW);
		pressDashboard(state, agents, "\x1b[B", NOW);
		rendered = renderDashboard(agents, state, { branch: "main", cwd: "~/repo" }, NOW, 80).join("\n");
		expect(rendered).toContain("looking");
		expect(rendered).toContain("❯ reply");
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
		const view = new DashboardView(
			{
				exit: () => seen.push("exit"),
				create: () => seen.push("create"),
				openPrevious: () => seen.push("previous"),
				open: () => seen.push("open"),
				dispatch: () => seen.push("dispatch"),
				reply: () => seen.push("reply"),
				rename: () => seen.push("rename"),
				stop: () => seen.push("stop"),
				delete: () => seen.push("delete"),
				status: () => seen.push("status"),
				prefs: () => seen.push("prefs"),
				opened: (open) => seen.push(open ? "opened" : "closed"),
			},
			() => [agent("live", { state: "working", attached: true, peek: "hello" })],
			() => ({ branch: "main", cwd: "~/repo" }),
			undefined,
			() => NOW,
		);
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

	test("records the same outcomes on a second pass", () => {
		const agents = [agent("live", { state: "working", attached: true })];
		expect(effects(agents, ["\x1c", "\r"]).map((effect) => effect.type)).toEqual(["none", "create"]);
		expect(effects(agents, ["\x1c", "\r"]).map((effect) => effect.type)).toEqual(["none", "create"]);
	});
});
