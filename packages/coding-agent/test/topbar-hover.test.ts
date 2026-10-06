import { Container, Text } from "@amazme/tui";
import { beforeAll, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	FooterComponent,
	SessionTopBar,
} from "../src/modes/interactive/components/footer.ts";
import {
	getEditorTheme,
	initTheme,
} from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";

beforeAll(() => initTheme("dark", false));

function fixture() {
	const terminal = new VirtualTerminal(100, 24);
	const ui = createInteractiveTui({
		tuiMode: "fullscreen",
		terminal,
		showHardwareCursor: false,
		logDirectory: "/tmp",
	});
	const session = {
		state: {
			model: { id: "model", provider: "provider", contextWindow: 272_000 },
		},
		sessionManager: {
			getSessionId: () => "test",
			getLeafId: () => null,
			getEntryCount: () => 0,
			getEntries: () => [],
			getSessionName: () => "Current session",
			getCwd: () => "/repo",
		},
		getContextUsage: () => ({
			tokens: 158_000,
			contextWindow: 272_000,
			percent: 58.3,
		}),
		modelRuntime: { isUsingSubscription: () => true },
	} as unknown as AgentSession;
	const footer = new FooterComponent(session, {
		getGitBranch: () => "main",
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map<string, string>(),
		onBranchChange: () => () => {},
	});
	const editor = new CustomEditor(
		ui,
		getEditorTheme(),
		new KeybindingsManager(),
	);
	const bar = new SessionTopBar(
		footer,
		() => {},
		() => {},
	);
	const viewport = createChatViewport({
		document: new Text(
			Array.from({ length: 60 }, (_, i) => `Transcript ${i}`).join("\n"),
			0,
			0,
		),
		statusBar: bar,
		editor,
		pendingMessages: new Container(),
		status: new Container(),
		footer: new Container(),
	});
	ui.setLayoutRoot(viewport.root);
	ui.setFocus(editor);
	ui.start();
	const hover = async () => {
		const hit = footer.contextHitRange();
		expect(hit).toBeDefined();
		terminal.sendInput(`\x1b[<35;${(hit?.start ?? 0) + 1};1M`);
		await terminal.waitForRender();
		expect(terminal.getViewport()[0]).toContain("███░░ 58.3%");
		expect(footer.contextHovering()).toBe(true);
	};
	return { terminal, ui, footer, editor, viewport, hover };
}

test("context meter exists only during actual pointer hover, including exits to chat, editor, and top-bar labels", async () => {
	const f = fixture();
	try {
		await f.terminal.waitForRender();
		const initial = f.terminal.getViewport()[0];
		expect(initial).toContain("158k / 272k");
		expect(initial).not.toContain("58.3%");
		const scrollTop = f.viewport.transcript.scrollTop;
		for (const move of [
			"\x1b[<35;2;1M",
			"\x1b[<35;99;1M",
			"\x1b[<35;2;2M",
			"\x1b[<35;2;22M",
		]) {
			await f.hover();
			const hit = f.footer.contextHitRange();
			f.terminal.sendInput(move);
			await f.terminal.waitForRender();
			expect(f.footer.contextHovering()).toBe(false);
			expect(f.terminal.getViewport()[0]).toBe(initial);
			expect(f.footer.contextHitRange()).toEqual(hit);
			expect(f.viewport.transcript.scrollTop).toBe(scrollTop);
			expect(f.ui.getFocusedComponent()).toBe(f.editor);
		}
	} finally {
		f.ui.stop();
	}
});

test("terminal focus loss immediately restores the count rather than leaving the meter latched", async () => {
	const f = fixture();
	try {
		await f.terminal.waitForRender();
		const initial = f.terminal.getViewport()[0];
		await f.hover();
		f.terminal.sendInput("\x1b[O");
		await f.terminal.waitForRender();
		expect(f.footer.contextHovering()).toBe(false);
		expect(f.terminal.getViewport()[0]).toBe(initial);
		await f.hover();
	} finally {
		f.ui.stop();
	}
	expect(f.footer.contextHovering()).toBe(false);
});
