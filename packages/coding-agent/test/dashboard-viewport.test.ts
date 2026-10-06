import { Container, isViewportTUI, Text } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { type DashboardAgent, DashboardView } from "../src/modes/interactive/dashboard.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const NOW = 1_700_000_000_000;

function sessions(): DashboardAgent[] {
	return Array.from({ length: 40 }, (_unused, index) => ({
		id: `session-${index}`,
		name: `Session ${index}`,
		cwd: "/repo",
		state: "idle",
		activity: "idle",
		updatedAt: NOW - 60_000,
		attached: index === 18,
		lastQuestion: `Question ${index}`,
	}));
}

function fixture() {
	let agents = sessions();
	let synchronize: (open: boolean) => void = () => {};
	const seen: string[] = [];
	const terminal = new VirtualTerminal(80, 16);
	const ui = createInteractiveTui({ tuiMode: "fullscreen", showHardwareCursor: true, logDirectory: "/tmp", terminal });
	if (!isViewportTUI(ui)) throw new Error("Expected fullscreen layout support");
	const editor = Object.assign(new Text("> prompt", 0, 0), {
		hidden: false,
		handleInput: (data: string): void => { view.handleKey(data); },
	});
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const pendingMessagesContainer = new Container();
	const statusContainer = new Container();
	const footerContainer = new Container();
	const widgetContainerAbove = new Container();
	const widgetContainerBelow = new Container();
	const statusBar = new Text("project /repo (main)", 0, 0);
	const chat = createChatViewport({
		document: new Text(Array.from({ length: 60 }, (_unused, index) => `chat ${index}`).join("\n"), 0, 0),
		pendingMessages: pendingMessagesContainer,
		status: statusContainer,
		editor: editorContainer,
		footer: footerContainer,
		statusBar,
	});
	const view: DashboardView = new DashboardView({
		exit: () => synchronize(false),
		create: () => seen.push("new"),
		openPrevious: () => seen.push("previous"),
		open: (id) => seen.push(`open:${id}`),
		dispatch: (text) => seen.push(`dispatch:${text}`),
		reply: (id, text) => seen.push(`reply:${id}:${text}`),
		rename: (id, title) => seen.push(`rename:${id}:${title}`),
		stop: (id) => seen.push(`stop:${id}`),
		delete: (id) => seen.push(`delete:${id}`),
		status: (text) => seen.push(`status:${text}`),
		prefs: () => {},
		opened: (open) => synchronize(open),
		focusInput: () => ui.setFocus(editor),
		focusList: () => ui.setFocus(view),
	}, () => agents, () => ({ branch: "main", cwd: "/repo" }), undefined, () => NOW);
	const context = {
		dashboard: () => view,
		dashboardLayoutRoot: undefined,
		fullscreenLayoutRoot: chat.root,
		renderer: ui,
		ui,
		session: { childAgents: { close: () => {} } },
		settingsManager: { getFullscreenScrollbar: () => "hidden" },
		statusBar,
		pendingMessagesContainer,
		statusContainer,
		editorContainer,
		footerContainer,
		widgetContainerAbove,
		widgetContainerBelow,
		defaultEditor: editor,
		editor,
		workSurface: { composerHidden: false },
		parentTranscript: { setOverlay: () => {} },
		setStartupChrome: () => {},
		footer: { setComposerLine: () => {} },
		reloadDashboardDisk: async () => {},
	};
	const prototype = InteractiveMode.prototype as unknown as {
		syncDashboard(this: typeof context, open: boolean): void;
	};
	synchronize = (open) => prototype.syncDashboard.call(context, open);
	ui.setLayoutRoot(chat.root);
	ui.start();
	return { terminal, ui, view, chat, seen, editor, replaceAgents: (next: DashboardAgent[]) => { agents = next; ui.requestRender(); } };
}

function expectSessionVisible(terminal: VirtualTerminal, index: number): void {
	const lines = terminal.getViewport();
	const row = lines.findIndex((line) => line.includes(`Session ${index}`));
	expect(row).toBeGreaterThan(0);
	expect(lines[row]).toContain("▌");
	expect(lines[row + 1]).toContain(`Question ${index}`);
}

describe("dashboard fullscreen viewport", () => {
	beforeAll(() => initTheme("dark", false));

	test("opens at the current session and restores the independent chat position on close", async () => {
		const { terminal, ui, view, chat } = fixture();
		try {
			await terminal.waitForRender();
			chat.transcript.scrollTo(20, { disableFollow: true });
			await terminal.waitForRender();
			const before = terminal.getViewport();
			view.toggle();
			await terminal.waitForRender();
			expectSessionVisible(terminal, 18);
			expect(view.scrollView.isFollowingEnd).toBe(false);
			expect(chat.transcript.scrollTop).toBe(20);
			terminal.sendInput("\x1c");
			await terminal.waitForRender();
			expect(view.isOpen()).toBe(false);
			expect(chat.transcript.scrollTop).toBe(20);
			expect(terminal.getViewport()).toEqual(before);
		} finally { ui.stop(); }
	});

	test("keeps both selected lines visible during navigation, data reload and narrow resizing", async () => {
		const { terminal, ui, view, replaceAgents } = fixture();
		try {
			await terminal.waitForRender();
			view.toggle();
			await terminal.waitForRender();
			for (let index = 19; index <= 24; index++) {
				terminal.sendInput("\x1b[B");
				await terminal.waitForRender();
				expectSessionVisible(terminal, index);
			}
			const extra = sessions().slice(0, 5).map((agent, index) => ({ ...agent, id: `extra-${index}`, name: `Extra ${index}`, attached: false }));
			replaceAgents([...extra, ...sessions()]);
			await terminal.waitForRender();
			expectSessionVisible(terminal, 24);
			terminal.resize(40, 10);
			await terminal.waitForRender();
			expectSessionVisible(terminal, 24);
			terminal.sendInput("\x1b[A");
			await terminal.waitForRender();
			expectSessionVisible(terminal, 23);
		} finally { ui.stop(); }
	});

	test("manual wheel scrolling is not immediately pulled back to the keyboard cursor", async () => {
		const { terminal, ui, view } = fixture();
		try {
			await terminal.waitForRender();
			view.toggle();
			await terminal.waitForRender();
			const before = view.scrollView.scrollTop;
			terminal.sendInput("\x1b[<65;2;6M");
			await terminal.waitForRender();
			expect(view.scrollView.scrollTop).toBeGreaterThan(before);
			const after = view.scrollView.scrollTop;
			ui.requestRender();
			await terminal.waitForRender();
			expect(view.scrollView.scrollTop).toBe(after);
			terminal.sendInput("\x1b[B");
			await terminal.waitForRender();
			expectSessionVisible(terminal, 19);
		} finally { ui.stop(); }
	});

	test("Tab returns from the prompt to the list and hints follow the actual reply target", async () => {
		const { terminal, ui, view, editor, seen } = fixture();
		try {
			await terminal.waitForRender();
			view.toggle();
			await terminal.waitForRender();
			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(ui.getFocusedComponent()).toBe(editor);
			expect(view.composerShortcutLine()).toContain("Tab\x1b[22m:list");
			terminal.sendInput("j");
			await terminal.waitForRender();
			expect(terminal.getViewport().some((line) => line.includes("Reply: j"))).toBe(true);
			terminal.sendInput("\t");
			await terminal.waitForRender();
			expect(ui.getFocusedComponent()).toBe(view);
			expect(view.composerShortcutLine()).toContain("Enter\x1b[22m:reply");
			terminal.sendInput("\r");
			await terminal.waitForRender();
			expect(seen).toContain("reply:session-18:j");
		} finally { ui.stop(); }
	});

	test("mouse rename keeps keyboard ownership on the delegating body after cancellation", async () => {
		const { terminal, ui, view, seen } = fixture();
		try {
			await terminal.waitForRender();
			view.toggle();
			await terminal.waitForRender();
			const row = terminal.getViewport().findIndex((line) => line.includes("Session 18"));
			terminal.sendInput(`\x1b[<35;4;${row + 1}M`);
			await terminal.waitForRender();
			expect(terminal.getViewport()[row]).toContain("[rename]");
			terminal.sendInput(`\x1b[<0;70;${row + 1}M`);
			terminal.sendInput(`\x1b[<0;70;${row + 1}m`);
			await terminal.waitForRender();
			expect(terminal.getViewport()[row]).toContain("> Session 18");
			expect(terminal.getCursorPosition().y).toBe(row);
			terminal.sendInput("\x1b");
			terminal.sendInput("\r");
			await terminal.waitForRender();
			expect(seen).toContain("open:session-18");
			expect(seen.some((item) => item.startsWith("rename:"))).toBe(false);
		} finally { ui.stop(); }
	});

	test("very short viewports prioritize the selected title instead of showing only its question", async () => {
		const { terminal, ui, view } = fixture();
		try {
			await terminal.waitForRender();
			view.toggle();
			await terminal.waitForRender();
			terminal.resize(24, 8);
			await terminal.waitForRender();
			const row = terminal.getViewport().find((line) => line.includes("Session 18"));
			expect(row).toContain("▌");
			expect(view.scrollView.viewportHeight).toBe(1);
		} finally { ui.stop(); }
	});

	test("the attached session remains reachable when older idle sessions are collapsed", async () => {
		const { terminal, ui, view, replaceAgents } = fixture();
		try {
			await terminal.waitForRender();
			replaceAgents(sessions().map((agent) => ({ ...agent, updatedAt: NOW - 2 * 60 * 60 * 1000 })));
			view.toggle();
			await terminal.waitForRender();
			expectSessionVisible(terminal, 18);
			expect(view.render(80).join("\n")).toContain("31 more");
		} finally { ui.stop(); }
	});

	test("Previous is clickable through the bounded layout and long-list rename retains IME focus", async () => {
		const { terminal, ui, view, seen } = fixture();
		try {
			await terminal.waitForRender();
			view.toggle();
			await terminal.waitForRender();
			terminal.sendInput("\x12");
			await terminal.waitForRender();
			const titleRow = terminal.getViewport().findIndex((line) => line.includes("> Session 18"));
			expect(titleRow).toBeGreaterThan(0);
			expect(terminal.getCursorPosition().y).toBe(titleRow);
			expect(terminal.getViewport().some((line) => line.includes("Enter save"))).toBe(true);
			terminal.sendInput("\x15");
			terminal.sendInput("\x1b[200~中文标题\x1b[201~");
			terminal.sendInput("\r");
			await terminal.waitForRender();
			expect(seen).toContain("rename:session-18:中文标题");
			terminal.sendInput("\x1b");
			terminal.sendInput("\x1b[C");
			await terminal.waitForRender();
			const row = terminal.getViewport().findIndex((line) => line.includes("Open Previous"));
			expect(terminal.getViewport()[row]).toContain("▌Open Previous");
			terminal.sendInput(`\x1b[<0;70;${row + 1}M`);
			terminal.sendInput(`\x1b[<0;70;${row + 1}m`);
			await terminal.waitForRender();
			expect(seen).toContain("previous");
		} finally { ui.stop(); }
	});
});
