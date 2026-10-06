import { CURSOR_MARKER, sliceByColumn, stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import {
	type DashboardAgent,
	type DashboardEffect,
	type DashboardHit,
	DashboardView,
	defaultDashboardState,
	formatDashboardAge,
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
		lastQuestion: "",
		lastReply: "",
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
	const view: DashboardView = new DashboardView(
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
			focusList: () => {
				view.focused = true;
			},
		},
		agentsOf,
		() => ({ branch: "main", cwd: "~/repo" }),
		undefined,
		() => NOW,
	);
	return view;
}

function mouse(type: "move" | "click" | "press", x: number, y: number): TuiMouseEvent {
	return {
		type,
		button: type === "move" ? "none" : "left",
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

	test("opens with session titles and latest questions, and steps back out", () => {
		const agents = [
			agent("live", { name: "reviewer", state: "working", activity: "Responding…", attached: true, lastQuestion: "Review this change" }),
			agent("old", { name: "housekeeping", updatedAt: NOW - 3_600_000 }),
		];
		const state = defaultDashboardState();
		expect(pressDashboard(state, agents, "\x1c", NOW).type).toBe("none");
		expect(state.open).toBe(true);
		expect(state.focus).toBe("list");
		let rendered = renderDashboard(agents, state, { branch: "main", cwd: "~/repo" }, NOW, 80).join("\n");
		expect(rendered).toContain("Sessions 2");
		expect(rendered).not.toContain("main ~/repo");
		expect(rendered).toContain("1 working │ ◇ 1 idle");
		expect(rendered).toContain("+ New Agent");
		expect(rendered).toContain("Open Previous /resume");
		expect(rendered).toContain("reviewer");
		expect(rendered).toContain("1m");
		expect(rendered).toContain("Review this change");

		pressDashboard(state, agents, "\x1b[B", NOW);
		pressDashboard(state, agents, "\x1b[B", NOW);
		rendered = renderDashboard(agents, state, { branch: "main", cwd: "~/repo" }, NOW, 80).join("\n");
		expect(rendered).toContain("Review this change");
		expect(state.selected).toBe("row:live");

		expect(pressDashboard(state, agents, "\x1b", NOW).type).toBe("none");
		expect(state.selected).toBe("actions");
		expect(pressDashboard(state, agents, "\x1b", NOW)).toEqual({ type: "exit" });
		expect(state.open).toBe(false);
	});

	test("ages read as just now, minutes, hours, and days", () => {
		expect(formatDashboardAge(0)).toBe("just now");
		expect(formatDashboardAge(59_999)).toBe("just now");
		expect(formatDashboardAge(60_000)).toBe("1m");
		expect(formatDashboardAge(3_600_000)).toBe("1h");
		expect(formatDashboardAge(47 * 3_600_000)).toBe("47h");
		expect(formatDashboardAge(48 * 3_600_000)).toBe("2d");
	});

	test("the header carries state chips and every section folds its rule onto the title line", () => {
		const agents = [
			agent("live", { name: "current", state: "working", attached: true }),
			agent("waiting", { state: "needs-input", updatedAt: NOW - 5_000 }),
			agent("saved", { state: "idle", updatedAt: NOW - 8 * 3_600_000 }),
		];
		const state = defaultDashboardState();
		state.open = true;
		const lines = renderDashboard(agents, state, { branch: null, cwd: "/repo" }, NOW, 80).map(stripTerminalSequences);
		expect(lines[0]).toMatch(/^Sessions 3 .*1 awaiting │ 1 working │ ◇ 1 idle$/);
		expect(lines[1]).toContain("New Agent");
		expect(lines[2]).toMatch(/^ ▾ Needs input 1 ─+$/);
		// The rule belongs to the title line, so no section costs a second line.
		expect(lines.some((line) => /^─+$/.test(line.trim()))).toBe(false);
		expect(lines.join("\n")).toContain("just now");
	});

	test("the current session offers rename but no close badge, and keeps every age on one column", () => {
		const seen: string[] = [];
		const view = viewFor(
			() => [agent("live", { name: "current", attached: true }), agent("saved", { name: "saved" })],
			seen,
		);
		view.toggle();
		// The cursor frames the current session on open, so compare the ages with the cursor off the list.
		view.handleKey("\x1b");
		const before = view.render(80);
		const liveRow = before.findIndex((line) => line.includes(" current"));
		const savedRow = before.findIndex((line) => line.includes(" saved"));
		const ageColumn = (line: string) => stripTerminalSequences(line).indexOf("1m");
		expect(ageColumn(before[liveRow]!)).toBe(ageColumn(before[savedRow]!));
		expect(view.handleMouse(mouse("move", 2, liveRow))).toEqual({ handled: true, render: true });
		const hovered = view.render(80);
		expect(hovered[liveRow]).toContain("[rename]");
		expect(hovered[liveRow]).not.toContain("[x]");
		expect(hovered[savedRow]).not.toContain("[rename]");
		view.handleMouse(mouse("click", 78, liveRow));
		expect(seen).not.toContain("stop:live");
		expect(seen).not.toContain("delete:live");
	});

	test("ctrl+x leaves the current session open and still deletes another session", () => {
		const agents = [agent("live", { state: "idle", attached: true }), agent("saved", { state: "idle" })];
		const state = defaultDashboardState();
		pressDashboard(state, agents, "\x1c", NOW);
		state.selected = "row:live";
		expect(pressDashboard(state, agents, "\x18", NOW)).toEqual({
			type: "status",
			text: "The current session stays open",
		});
		expect(state.deleteArmedFor).toBeUndefined();
		state.selected = "row:saved";
		expect(pressDashboard(state, agents, "\x18", NOW)).toEqual({
			type: "status",
			text: "Press Ctrl+X again to delete this session",
		});
		expect(pressDashboard(state, agents, "\x18", NOW)).toEqual({ type: "delete", id: "saved" });
	});

	test("the cursor frames its row, which stands apart from the current session's fill", () => {
		const view = viewFor(() => [agent("live", { attached: true }), agent("saved")]);
		view.toggle();
		const lines = view.render(80).map(stripTerminalSequences);
		const row = lines.findIndex((line) => line.includes(" live"));
		expect(lines[row - 1]).toMatch(/^╭─+╮$/);
		expect(lines[row]).toMatch(/^│ ◇ live/);
		expect(lines[row + 1]).toContain("No question yet");
		expect(lines[row + 2]).toMatch(/^╰─+╯$/);
		// The frame replaces the bar cursor, so the two highlights never spell the same thing.
		expect(lines.join("\n")).not.toContain("▌");
		for (const line of view.render(80)) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	test("the reply preview follows the cursor, clips, and steps aside for quiet slots", () => {
		const view = viewFor(() => [
			agent("live", { name: "current", attached: true, lastReply: "First line\n\nSecond line" }),
			agent("saved", { name: "saved", lastReply: "Saved reply" }),
		]);
		view.toggle();
		const opened = view.render(80).map(stripTerminalSequences).join("\n");
		expect(opened).toContain("Response");
		expect(opened).toContain("First line");
		expect(opened).toContain("Second line");
		for (let step = 0; step < 3; step++) view.handleKey("\x1b[B");
		const moved = view.render(80).map(stripTerminalSequences).join("\n");
		expect(moved).toContain("Saved reply");
		expect(moved).not.toContain("First line");
		// The preview belongs to session rows, so the action and section slots drop it.
		view.handleKey("\x1b");
		expect(view.render(80).join("\n")).not.toContain("Response");
	});

	test("the reply preview reports the lines it clips and never widens the row", () => {
		const reply = Array.from({ length: 8 }, (_unused, index) => `line ${index}`).join("\n\n");
		const view = viewFor(() => [agent("live", { attached: true, lastReply: reply })]);
		view.toggle();
		for (const width of [22, 24, 40, 80]) {
			const lines = view.render(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const text = lines.map(stripTerminalSequences).join("\n");
			if (width < 24) {
				expect(text).not.toContain("Response");
				continue;
			}
			expect(text).toContain("line 0");
			expect(text).toMatch(/… \d+ more lines/);
		}
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
		const view = viewFor(() => [agent("live", { state: "working", attached: true, lastQuestion: "hello" })], seen);
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
				agent("live", { name: "当前会话", cwd: "/repo/中文", attached: true, lastQuestion: "live question" }),
				agent("saved", { name: "另一会话", cwd: "/repo/中文", lastQuestion: "saved question" }),
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
					expect(lines.filter((line) => line.includes(background))).toHaveLength(2);
					// The frame insets its row by two columns, so only an unframed question fits whole at 16.
					const question = stripTerminalSequences(lines[savedRow + 1] ?? "");
					expect(question).toContain(selected === "row:saved" ? "saved quest" : "saved question");
					expect(lines[savedRow + 1]).not.toContain(background);
					if (selected === "row:saved") expect(stripTerminalSequences(lines[savedRow]!)).toMatch(/^│ ◇/);
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		} finally {
			initTheme("dark");
		}
	});

	test("refreshes the highlighted session from the current attachment, not the action cursor", () => {
		let agents = [agent("live", { attached: true, lastQuestion: "live question" }), agent("saved")];
		const view = viewFor(() => agents);
		view.toggle();
		const background = theme.getBgAnsi("selectedBg");
		expect(view.render(80).filter((line) => line.includes(background))).toHaveLength(2);

		agents = agents.map((item) => ({ ...item, attached: item.id === "saved" }));
		const lines = view.render(80);
		expect(lines.find((line) => line.includes(" live"))).not.toContain(background);
		expect(lines.find((line) => line.includes("live question"))).not.toContain(background);
		expect(lines.find((line) => line.includes(" saved"))).toContain(background);
		expect(lines.filter((line) => line.includes(background))).toHaveLength(2);

		agents = agents.map((item) => ({ ...item, attached: false }));
		expect(view.render(80).filter((line) => line.includes(background))).toEqual([]);
	});

	test("hover reveals actions without changing the two-line layout, reply, or rename targets", () => {
		const seen: string[] = [];
		const agents = [agent("live", { attached: true, lastQuestion: "live question" }), agent("saved", { lastQuestion: "saved question" })];
		const view = viewFor(() => agents, seen);
		view.toggle();
		view.handleKey("h");
		view.handleKey("i");
		const before = view.render(80);
		const row = before.findIndex((line) => line.includes(" saved"));
		expect(row).toBeGreaterThan(0);
		expect(view.handleMouse(mouse("move", 2, row))).toEqual({ handled: true, render: true });
		const hovered = view.render(80);
		expect(hovered).toHaveLength(before.length);
		expect(hovered[row]).toContain("[x]");
		expect(hovered[row]).toContain("[rename]");
		// The row badges are pointer-only, so the dashboard chrome names the same-work keys.
		expect(view.shortcutLine()).toContain("Ctrl+R");
		expect(view.shortcutLine()).toContain("Ctrl+X");
		view.setPointerInput(false);
		expect(stripTerminalSequences(view.render(80).join("\n"))).toContain("Ctrl+R rename");
		expect(stripTerminalSequences(view.render(80).join("\n"))).toContain("Ctrl+X close");
		view.setPointerInput(true);
		expect(hovered[row]).not.toContain(theme.getBgAnsi("selectedBg"));
		expect(hovered[row + 1]).toBe(before[row + 1]);
		expect(hovered.filter((line) => line.includes(theme.getBgAnsi("selectedBg")))).toEqual(
			before.filter((line) => line.includes(theme.getBgAnsi("selectedBg"))),
		);
		expect(view.handleMouse(mouse("move", 2, row))).toEqual({ handled: true, render: false });

		// Leaving the component is what used to strand the hover-only badges.
		expect(view.handleMouseLeave()).toBe(true);
		expect(view.render(80)[row]).not.toContain("[rename]");
		expect(view.render(80)[row]).not.toContain("[x]");
		expect(view.render(80)).toEqual(before);
		expect(view.handleMouseLeave()).toBe(false);

		view.handleMouse(mouse("move", 2, row));
		view.handleMouse(mouse("move", 2, 0));
		expect(view.render(80)).toEqual(before);
		view.handleKey("\r");
		expect(seen).toEqual(["opened", "reply:live:hi"]);

		view.handleMouse(mouse("move", 2, row));
		view.handleKey("\x12");
		expect(stripTerminalSequences(view.render(80).join("\n"))).toContain("> live");
		view.handleKey("\r");
		expect(seen.at(-1)).toBe("rename:live:live");
	});

	test("click opens a session and the close badge takes two clicks", () => {
		const seen: string[] = [];
		const saved = agent("saved", { name: "notes", lastQuestion: "hello notes", cwd: "/repo/notes" });
		const view = viewFor(() => [agent("live", { attached: true }), saved], seen);
		view.toggle();
		let lines = view.render(80);
		const row = lines.findIndex((line) => line.includes("notes"));
		expect(row).toBeGreaterThan(0);
		view.handleMouse(mouse("move", 2, row));
		lines = view.render(80);
		expect(lines[row] ?? "").toContain("[x]");
		expect(lines[row + 1]).toContain("hello notes");
		// Clicking the row moves the cursor onto it, which frames it one line further down.
		view.handleMouse(mouse("click", 2, row));
		expect(seen).toContain("open:saved");
		lines = view.render(80);
		const framed = lines.findIndex((line) => line.includes("notes"));
		expect(stripTerminalSequences(lines[framed - 1] ?? "")).toMatch(/^╭─/);
		expect(lines[framed + 1] ?? "").toContain("hello notes");
		expect(lines[framed]).not.toContain(theme.getBgAnsi("selectedBg"));
		expect(lines[framed + 1]).not.toContain(theme.getBgAnsi("selectedBg"));
		view.handleMouse(mouse("click", 78, framed));
		expect(seen).not.toContain("delete:saved");
		expect(view.render(80).join("\n")).toContain("再点一次关闭");
		view.handleMouse(mouse("click", 78, framed));
		expect(seen).toContain("delete:saved");
	});

	test("always renders exactly two hit-testable lines per session, including narrow and empty cases", () => {
		const agents = [
			agent("live", { name: "长标题\n第二行", attached: true, lastQuestion: "  最新问题\n继续\t提问 \x1b[31m中文\x1b[0m" }),
			agent("saved"),
		];
		const state = defaultDashboardState();
		state.open = true;
		for (const width of [0, 1, 8, 16, 40, 80]) {
			const hits: DashboardHit[] = [];
			const before = renderDashboard(agents, state, { branch: null, cwd: "~/repo" }, NOW, width, hits);
			for (const id of ["live", "saved"]) {
				const rows = hits.filter((hit) => hit.kind === "row" && hit.id === id);
				expect(rows).toHaveLength(2);
				expect(rows[1]!.line).toBe(rows[0]!.line + 1);
			}
			state.selected = "row:saved";
			expect(renderDashboard(agents, state, { branch: null, cwd: "~/repo" }, NOW, width)).toHaveLength(before.length);
			for (const line of before) {
				expect(line).not.toContain("\n");
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const lines = renderDashboard(agents, state, { branch: null, cwd: "~/repo" }, NOW, 80);
		expect(stripTerminalSequences(lines.join("\n"))).toContain("长标题 第二行");
		expect(stripTerminalSequences(lines.join("\n"))).toContain("最新问题 继续 提问 中文");
		expect(lines.join("\n")).toContain("No question yet");
		expect(lines.join("\n")).not.toContain("\x1b[31m");
	});

	test("search matches the latest question as well as the title", () => {
		const state = defaultDashboardState();
		state.filter = "login failure";
		const agents = [agent("saved", { lastQuestion: "How do I fix the login failure?" }), agent("other")];
		const hits: DashboardHit[] = [];
		renderDashboard(agents, state, { branch: null, cwd: "~/repo" }, NOW, 80, hits);
		expect(hits.filter((hit) => hit.kind === "row").map((hit) => hit.id)).toEqual(["saved", "saved"]);
	});

	test("clicking either line opens that session; hovering its question shows title actions only", () => {
		const seen: string[] = [];
		const view = viewFor(() => [agent("saved", { lastQuestion: "Latest question" })], seen);
		view.toggle();
		const before = view.render(80);
		const row = before.findIndex((line) => line.includes(" saved"));
		view.handleMouse(mouse("move", 2, row + 1));
		const hovered = view.render(80);
		expect(hovered[row]).toContain("[rename]");
		expect(hovered[row]).toContain("[x]");
		expect(hovered[row + 1]).toBe(before[row + 1]);
		view.handleMouse(mouse("click", 78, row + 1));
		expect(seen).toEqual(["opened", "open:saved"]);
	});

	test("the title rename button edits inline, supports Unicode and paste, and never opens the session", () => {
		const seen: string[] = [];
		let saved = agent("saved", { lastQuestion: "Saved question" });
		const live = agent("live", { attached: true, lastQuestion: "Current question" });
		const view = viewFor(() => [live, saved], seen);
		view.focused = true;
		view.toggle();
		let lines = view.render(80);
		const row = lines.findIndex((line) => line.includes(" saved"));
		view.handleMouse(mouse("move", 2, row));
		view.render(80);
		expect(view.handleMouse(mouse("click", 70, row))).toEqual({ handled: true, render: true, focus: true });
		lines = view.render(80);
		// Renaming moves the cursor onto the row, which frames it and shifts its lines down by one.
		const framed = lines.findIndex((line) => stripTerminalSequences(line).includes("> saved"));
		expect(stripTerminalSequences(lines[framed]!)).toContain("> saved");
		expect(lines[framed]).toContain(CURSOR_MARKER);
		expect(lines[framed + 1]).toContain("Saved question");
		expect(view.shortcutLine()).toContain("Enter save");
		expect(seen).toEqual(["opened"]);
		view.handleInput("\x15");
		view.handleInput("\x1b[200~新标题\x1b[201~");
		view.handleInput("\x1b[97u");
		view.handleInput("\x1b[1;9D");
		view.handleInput("[");
		view.handleInput("\x1b[1;9C");
		view.handleInput("]");
		view.handleInput("\r");
		expect(seen).toEqual(["opened", "rename:saved:[新标题a]"]);
		saved = { ...saved, name: "[新标题a]" };
		lines = view.render(80);
		const renamed = lines.findIndex((line) => stripTerminalSequences(line).includes("[新标题a]"));
		expect(stripTerminalSequences(lines[renamed]!)).toContain("[新标题a]");
		expect(lines[renamed + 1]).toContain("Saved question");
		expect(lines[renamed]).not.toContain(theme.getBgAnsi("selectedBg"));
		expect(lines.filter((line) => line.includes(theme.getBgAnsi("selectedBg")))).toHaveLength(2);
	});

	test("rename cancellation and empty submission preserve titles and modal input does not retarget", () => {
		const seen: string[] = [];
		const view = viewFor(() => [agent("live", { attached: true }), agent("saved")], seen);
		view.toggle();
		const before = view.render(80);
		const row = before.findIndex((line) => line.includes(" saved"));
		view.focused = false;
		view.handleKey("\x12");
		expect(view.focused).toBe(true);
		expect(view.render(80).join("\n")).toContain(CURSOR_MARKER);
		view.handleKey("\x15");
		view.handleInput("discarded title");
		view.handleKey("\x1b[B");
		view.handleMouse(mouse("click", 2, row));
		view.handleKey("\x1b");
		expect(view.render(80)).toEqual(before);
		expect(seen).toEqual(["opened"]);

		view.handleKey("\x12");
		view.handleKey("\x15");
		view.handleKey("\r");
		expect(seen).toEqual(["opened", "status:Name left unchanged"]);
		expect(view.render(80).join("\n")).toContain(" live");
		view.handleKey("\x12");
		view.handleKey("\x15");
		view.handleInput("Kept title");
		view.handleKey("\x13");
		expect(seen.at(-1)).toBe("rename:live:Kept title");
	});

	test("rename input is disposed when closing and reopening the dashboard", () => {
		const view = viewFor(() => [agent("live", { attached: true })]);
		view.toggle();
		view.handleKey("\x1b[B");
		view.handleKey("\x1b[B");
		view.handleKey("\x12");
		view.handleKey("\x1c");
		expect(view.isOpen()).toBe(false);
		view.toggle();
		expect(view.shortcutLine()).not.toContain("Enter save");
		expect(view.render(80).join("\n")).not.toContain("Rename title");
	});

	test("marks both action columns and section focus, with non-overlapping mouse targets at every width", () => {
		for (const width of [1, 8, 16, 24, 32, 40, 80]) {
			const state = defaultDashboardState();
			state.open = true;
			state.column = 1;
			const hits: DashboardHit[] = [];
			const lines = renderDashboard([agent("saved")], state, { branch: null, cwd: "/repo" }, NOW, width, hits);
			const previous = hits.find((hit) => hit.kind === "previous")!;
			const create = hits.find((hit) => hit.kind === "new")!;
			expect(stripTerminalSequences(lines[previous.line]!).slice(previous.start ?? 0)).toMatch(/^▌/);
			if (create.line === previous.line) expect(create.end).toBeLessThanOrEqual(previous.start!);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);

			state.selected = "section:idle";
			expect(renderDashboard([agent("saved")], state, { branch: null, cwd: "/repo" }, NOW, width).some((line) => stripTerminalSequences(line).startsWith("▌"))).toBe(true);
		}
	});

	test("clicks New and Previous independently and does not activate the gap between them", () => {
		const seen: string[] = [];
		const view = viewFor(() => [], seen);
		view.toggle();
		const lines = view.render(80);
		const row = lines.findIndex((line) => line.includes("New Agent"));
		view.handleMouse(mouse("click", 2, row));
		view.handleMouse(mouse("click", 70, row));
		expect(view.handleMouse(mouse("click", 30, row))).toBeUndefined();
		expect(seen).toEqual(["opened", "create", "previous"]);
	});

	test("section clicks fold and expand; opening focuses and reveals the attached session", () => {
		const view = viewFor(() => [agent("live", { attached: true })]);
		view.toggle();
		let lines = view.render(80);
		// Opening puts the cursor on the attached session, which frames its row.
		const liveRow = lines.findIndex((line) => line.includes(" live"));
		expect(stripTerminalSequences(lines[liveRow - 1]!)).toMatch(/^╭─/);
		expect(stripTerminalSequences(lines[liveRow]!)).toMatch(/^│ ◇/);
		const section = lines.findIndex((line) => line.includes("Idle"));
		view.handleMouse(mouse("click", 3, section));
		lines = view.render(80);
		expect(stripTerminalSequences(lines[section]!)).toMatch(/^▌▸/);
		expect(lines.join("\n")).not.toContain("No question yet");
		view.handleMouse(mouse("click", 3, section));
		expect(view.render(80).join("\n")).toContain("No question yet");
	});

	test("section clicks fold during search instead of silently submitting the search", () => {
		const view = viewFor(() => [agent("saved")]);
		view.toggle();
		view.handleKey("\x1f");
		const lines = view.render(80);
		const section = lines.findIndex((line) => line.includes("Idle"));
		view.handleMouse(mouse("click", 3, section));
		const folded = view.render(80);
		expect(stripTerminalSequences(folded[section]!)).toMatch(/^▌▸/);
		expect(folded.join("\n")).toContain("Search:");
		expect(folded.join("\n")).not.toContain("No question yet");
	});

	test("hover keeps long titles byte-for-byte stable before the reserved action area", () => {
		for (const width of [16, 24, 40, 80]) {
			const state = defaultDashboardState();
			const title = "很长的会话标题和更多内容".repeat(3);
			const agents = [agent("saved", { name: title })];
			const beforeHits: DashboardHit[] = [];
			const before = renderDashboard(agents, state, { branch: null, cwd: "/repo" }, NOW, width, beforeHits);
			state.hoverId = "saved";
			const hits: DashboardHit[] = [];
			const hovered = renderDashboard(agents, state, { branch: null, cwd: "/repo" }, NOW, width, hits);
			const hit = hits.find((item) => item.kind === "row")!;
			const boundary = hit.renameStart ?? hit.closeStart ?? width;
			expect(stripTerminalSequences(sliceByColumn(hovered[hit.line]!, 0, boundary))).toBe(stripTerminalSequences(sliceByColumn(before[hit.line]!, 0, boundary)));
			expect(hovered[hit.line + 1]).toBe(before[hit.line + 1]);
			if (width === 40) expect(hovered[hit.line]).toContain("[r] [x]");
			if (width === 16) expect(hit.closeStart).toBeUndefined();
		}
	});

	test("composer placeholder names the focused reply, new-session, and rename targets", () => {
		const view = viewFor(() => [agent("live", { attached: true })]);
		view.toggle();
		expect(view.composerPlaceholder()).toBe("Reply to live");
		expect(stripTerminalSequences(view.composerShortcutLine())).toContain("Enter:open");
		view.handleKey("\x12");
		expect(view.composerPlaceholder()).toBe("Editing title above");
		expect(stripTerminalSequences(view.composerShortcutLine())).toBe("Ctrl+\\:dashboard");
		view.handleKey("\x1b");
		view.handleKey("\x1b");
		expect(view.composerPlaceholder()).toBe("Dispatch a new agent");
		expect(stripTerminalSequences(view.composerShortcutLine())).toContain("Enter:create");
	});

	test("composer chips name the keys that apply to the cursor", () => {
		const onCurrent = viewFor(() => [agent("live", { name: "current", state: "working", attached: true })]);
		onCurrent.toggle();
		const chips = stripTerminalSequences(onCurrent.composerShortcutLine());
		expect(chips).toContain("Esc:New Agent");
		expect(chips).toContain("?:help");
		expect(chips).toContain("Ctrl+X:stop");

		const idleCurrent = viewFor(() => [agent("live", { attached: true })]);
		idleCurrent.toggle();
		expect(stripTerminalSequences(idleCurrent.composerShortcutLine())).not.toContain("Ctrl+X");

		const view = viewFor(() => [agent("live", { name: "current", attached: true }), agent("saved")]);
		view.toggle();
		// The New Agent slot has nothing to back out of.
		view.handleKey("\x1b");
		expect(stripTerminalSequences(view.composerShortcutLine())).not.toContain("Esc:New Agent");
		for (let step = 0; step < 3; step++) view.handleKey("\x1b[B");
		expect(stripTerminalSequences(view.composerShortcutLine())).toContain("Ctrl+X:close");
	});

	test("header prioritizes status over location and narrow footer keeps rename controls", () => {
		const state = defaultDashboardState();
		state.open = true;
		state.renameFor = "live";
		const lines = renderDashboard([agent("live", { attached: true, state: "working" })], state, { branch: "very-long-branch", cwd: "/very/long/path" }, NOW, 24);
		expect(lines[0]).toContain("1 working");
		expect(lines.join("\n")).not.toContain("/very/long/path");
		expect(lines.at(-1)).toContain("Enter save");
		expect(lines.at(-1)).toContain("Esc cancel");
	});

	test("records the same outcomes on a second pass", () => {
		const agents = [agent("live", { state: "working", attached: true })];
		expect(effects(agents, ["\x1c", "\r"]).map((effect) => effect.type)).toEqual(["none", "create"]);
		expect(effects(agents, ["\x1c", "\r"]).map((effect) => effect.type)).toEqual(["none", "create"]);
	});
});
