import { type AutocompleteProvider, Container, getKeybindings, setKeybindings, TuiMainScreen } from "@amazme/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { ChildAgentBook } from "../src/core/child-session.ts";
import { foregroundCommands } from "../src/core/foreground-commands.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { detectTerminalClass, InteractiveComposer } from "../src/modes/interactive/composer-contract.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { routeInteractiveInput } from "../src/modes/interactive/interactive-input.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ParentTranscript } from "../src/modes/interactive/work-surface.ts";
import { scrollbackRows, TranscriptFocus } from "../src/modes/interactive/transcript-focus.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

const SHIFT_ENTER = "\x1b[27;2;13~";
const ALT_ENTER = "\x1b[27;3;13~";
const CTRL_ENTER = "\x1b[27;5;13~";
const CTRL_O = "\x0f";
const CTRL_L = "\x0c";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFooterSession(): AgentSession {
	const entries: unknown[] = [];
	return {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 1 }),
		routedModel: undefined,
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => undefined,
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

describe("interactive composer keys", () => {
	beforeAll(() => initTheme("dark"));

	test("enter, queue, send-now, ctrl+c, esc, and multiline follow the composer contract", async () => {
		const previous = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
		const effects: string[] = [];
		let turnRunning = false;
		const composer = new InteractiveComposer(editor, {
			isTurnRunning: () => turnRunning,
			send: (text) => effects.push(`send:${text}`),
			queue: (text) => effects.push(`queue:${text}`),
			sendQueued: (text) => effects.push(`send-queued:${text}`),
			cancelAndSend: (text) => effects.push(`cancel-and-send:${text}`),
			cancelTurn: () => effects.push("cancel"),
			showEscHint: () => effects.push("esc-hint"),
		});
		const scrolled: number[] = [];
		const filler = { render: () => ["status"] };
		const first = new BashExecutionComponent("first", ui);
		const second = new BashExecutionComponent("second", ui);
		const folded = Array.from({ length: 30 }, (_unused, index) => `row-${index}`).join("\n");
		first.appendOutput(folded);
		second.appendOutput(folded);
		const transcript = new TranscriptFocus(
			(lines) => scrolled.push(lines),
			() => scrollbackRows([filler, first, second], [], () => {}),
		);
		editor.onBeforeInput = (data) => routeInteractiveInput(data, { transcript, composer });
		const footer = new FooterComponent(createFooterSession(), createFooterData());
		footer.setComposerLine(() => composer.footerText());
		const footerText = () => footer.render(120).join("\n");

		editor.setAutocompleteProvider({
			getSuggestions: async (lines, _cursorLine, cursorCol) => {
				const prefix = lines[0]?.slice(0, cursorCol) ?? "";
				if (!prefix.startsWith("/") && !prefix.includes("@")) return null;
				return { items: [{ value: "item", label: "item" }], prefix };
			},
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		} satisfies AutocompleteProvider);

		try {
			expect(detectTerminalClass({ TERM_PROGRAM: "Apple_Terminal" })).toBe("apple-terminal");
			expect(detectTerminalClass({ TERM_PROGRAM: "vscode" })).toBe("vscode");
			expect(detectTerminalClass({ TERM_PROGRAM: "cursor" })).toBe("vscode");
			expect(detectTerminalClass({ TERM_PROGRAM: "windsurf" })).toBe("vscode");
			expect(detectTerminalClass({ TERM_PROGRAM: "zed" })).toBe("vscode");
			expect(detectTerminalClass({})).toBe("default");

			editor.setText("idle draft");
			editor.handleInput(CTRL_ENTER);
			editor.handleInput("\x1b");
			expect(effects).toEqual([]);
			expect(editor.getText()).toBe("idle draft");
			editor.setText("");
			editor.handleInput("\x03");
			expect(effects).toEqual([]);
			expect(editor.getText()).toBe("");

			editor.setText("hello");
			editor.handleInput("\r");
			expect(effects).toEqual(["send:hello"]);
			expect(editor.getText()).toBe("");
			expect(footerText()).toContain("Enter: send");
			expect(footerText()).toContain(
				process.platform === "darwin" ? "Newline: Shift+Enter or Option+Enter" : "Newline: Shift+Enter or Alt+Enter",
			);

			turnRunning = true;
			editor.setText("later");
			editor.handleInput("\r");
			expect(effects).toEqual(["send:hello", "queue:later"]);
			expect(composer.queue).toEqual(["later"]);
			expect(editor.getText()).toBe("");
			expect(footerText()).toContain("Enter: queue");
			expect(footerText()).toContain("Queued: later");

			editor.handleInput("\r");
			expect(effects.at(-1)).toBe("send-queued:later");
			expect(composer.queue).toEqual([]);
			expect(effects).not.toContain("cancel");

			editor.setText("stop this");
			editor.handleInput(CTRL_ENTER);
			expect(effects.at(-1)).toBe("cancel-and-send:stop this");
			expect(editor.getText()).toBe("");

			editor.setText("draft");
			const beforeCancel = effects.length;
			editor.handleInput("\x03");
			expect(editor.getText()).toBe("");
			expect(effects.slice(beforeCancel)).not.toContain("cancel");
			editor.handleInput("\x03");
			expect(effects.at(-1)).toBe("cancel");

			editor.setText("keep me");
			editor.handleInput("\x1b");
			expect(editor.getText()).toBe("keep me");
			expect(effects.at(-1)).toBe("esc-hint");
			expect(effects.filter((effect) => effect === "cancel")).toHaveLength(1);

			composer.multiline = false;
			editor.setText("one");
			editor.handleInput(SHIFT_ENTER);
			expect(editor.getText()).toBe("one\n");
			editor.handleInput(ALT_ENTER);
			expect(editor.getText()).toBe("one\n\n");

			composer.multiline = true;
			editor.setText("two");
			editor.handleInput("\r");
			expect(editor.getText()).toBe("two\n");
			expect(footerText()).toContain("Enter: newline");
			expect(footerText()).toContain(
				process.platform === "darwin" ? "Shift+Enter or Option+Enter: send" : "Shift+Enter or Alt+Enter: send",
			);
			editor.handleInput(SHIFT_ENTER);
			expect(effects.at(-1)).toBe("send:two");

			editor.setText("queued line");
			editor.handleInput(ALT_ENTER);
			expect(effects.at(-1)).toBe("send:queued line");

			editor.setText("   ");
			const beforeBlank = effects.length;
			editor.handleInput(SHIFT_ENTER);
			editor.handleInput(ALT_ENTER);
			expect(effects.slice(beforeBlank)).toEqual([]);
			expect(editor.getText()).toBe("   ");

			composer.multiline = false;
			composer.queue.push("top");
			editor.setText("");
			editor.handleInput("\r");
			expect(effects.at(-1)).toBe("send-queued:top");
			expect(composer.queue).toEqual([]);

			editor.setText("first queued");
			editor.handleInput("\r");
			editor.setText("second queued");
			editor.handleInput("\r");
			expect(composer.queue).toEqual(["first queued", "second queued"]);
			expect(footerText()).toContain("Queued: first queued | second queued");
			editor.setText("");
			editor.handleInput(CTRL_ENTER);
			expect(effects.at(-1)).toBe("cancel-and-send:first queued");
			expect(composer.queue).toEqual(["second queued"]);
			expect(footerText()).toContain("Queued: second queued");
			editor.handleInput(CTRL_ENTER);
			expect(effects.at(-1)).toBe("cancel-and-send:second queued");
			expect(composer.queue).toEqual([]);
			const beforeBareSendNow = effects.length;
			editor.handleInput(CTRL_ENTER);
			expect(effects.slice(beforeBareSendNow)).toEqual([]);

			composer.terminalClass = "apple-terminal";
			editor.setText("from apple");
			editor.handleInput(CTRL_O);
			expect(effects.at(-1)).toBe("cancel-and-send:from apple");
			expect(editor.getText()).toBe("");
			editor.setText("ctrl enter stays");
			const beforeAppleEnter = effects.length;
			editor.handleInput(CTRL_ENTER);
			expect(effects.slice(beforeAppleEnter)).toEqual([]);
			expect(editor.getText()).toBe("ctrl enter stays");

			composer.terminalClass = "vscode";
			editor.setText("from vscode");
			editor.handleInput(CTRL_L);
			expect(effects.at(-1)).toBe("cancel-and-send:from vscode");
			expect(editor.getText()).toBe("");
			editor.setText("ctrl o stays");
			const beforeVscodeO = effects.length;
			editor.handleInput(CTRL_O);
			expect(effects.slice(beforeVscodeO)).toEqual([]);
			expect(editor.getText()).toBe("ctrl o stays");

			composer.terminalClass = "default";
			editor.setText("default ignores");
			const beforeDefaultChords = effects.length;
			editor.handleInput(CTRL_O);
			editor.handleInput(CTRL_L);
			expect(effects.slice(beforeDefaultChords)).toEqual([]);
			expect(editor.getText()).toBe("default ignores");
			editor.setText("");

			editor.setText("");
			editor.handleInput("@src/main.ts");
			await sleep(40);
			expect(editor.getText()).toContain("@");
			expect(editor.isShowingAutocomplete()).toBe(true);
			editor.setText("");
			editor.handleInput("/help");
			await sleep(40);
			expect(editor.getText()).toContain("/");
			expect(editor.isShowingAutocomplete()).toBe(true);

			const draft = "keep this draft";
			editor.setText(draft);
			const firstCollapsed = first.render(40).length;
			const secondCollapsed = second.render(40).length;
			editor.handleInput("\t");
			expect(transcript.focus).toBe("scrollback");
			expect(transcript.selected).toBe(0);
			expect(editor.getText()).toBe(draft);
			editor.handleInput("\x1b[C");
			expect(first.render(40).length).toBeGreaterThan(firstCollapsed);
			expect(second.render(40).length).toBe(secondCollapsed);
			editor.handleInput("\x1b[B");
			expect(transcript.selected).toBe(1);
			editor.handleInput("\x1b[C");
			const firstExpanded = first.render(40).length;
			expect(second.render(40).length).toBeGreaterThan(secondCollapsed);
			expect(first.render(40).length).toBe(firstExpanded);
			editor.handleInput("\x1b[A");
			expect(transcript.selected).toBe(0);
			editor.handleInput("\x1b[D");
			expect(first.render(40).length).toBe(firstCollapsed);
			expect(second.render(40).length).toBeGreaterThan(secondCollapsed);
			editor.handleInput("\x1b[A");
			expect(transcript.selected).toBe(0);
			editor.handleInput("\x1b[5~");
			editor.handleInput("\x1b[6~");
			expect(scrolled).toEqual([-10, 10]);
			expect(transcript.focus).toBe("scrollback");
			expect(editor.getText()).toBe(draft);
			editor.handleInput("\t");
			expect(transcript.focus).toBe("prompt");
			expect(editor.getText()).toBe(draft);
			editor.handleInput("\x1b[5~");
			editor.handleInput("\x1b[6~");
			expect(scrolled).toEqual([-10, 10, -10, 10]);
			expect(transcript.focus).toBe("prompt");
			expect(editor.getText()).toBe(draft);
		} finally {
			setKeybindings(previous);
		}
	});

	test("the installed editor tells the user to press Ctrl+C and pages without changing the draft", () => {
		const previous = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
		const chat = new Container();
		const editorContainer = new Container();
		const parentTranscript = new ParentTranscript();
		const scrolled: number[] = [];
		let aborted = 0;
		const mode = {
			defaultEditor: editor,
			session: {
				isStreaming: true,
				childAgents: new ChildAgentBook(),
				abort: () => {
					aborted += 1;
				},
			},
			chatContainer: chat,
			editorContainer,
			parentTranscript,
			ui,
			footer: { setComposerLine(_render: () => string) {} },
			transcriptScrollView: { scrollBy: (lines: number) => scrolled.push(lines) },
			transcriptFocus: undefined as TranscriptFocus | undefined,
			ensureWorkSurface: Reflect.get(InteractiveMode.prototype, "ensureWorkSurface"),
			showStatus: Reflect.get(InteractiveMode.prototype, "showStatus"),
		};
		const install = Reflect.get(InteractiveMode.prototype, "installInteractiveInput") as () => void;
		const stops: Array<() => void> = [];
		const originalOnChange = foregroundCommands.onChange.bind(foregroundCommands);
		foregroundCommands.onChange = (listener: () => void) => {
			const stop = originalOnChange(listener);
			stops.push(stop);
			return stop;
		};
		try {
			install.call(mode);
			editor.setText("keep me");
			editor.handleInput("\x1b");
			expect(editor.getText()).toBe("keep me");
			expect(aborted).toBe(0);
			expect(chat.render(80).join("\n")).toContain("Press Ctrl+C to cancel the turn");

			editor.handleInput("\x03");
			expect(editor.getText()).toBe("");
			expect(aborted).toBe(0);
			editor.handleInput("\x03");
			expect(aborted).toBe(1);

			editor.setText("keep me");
			editor.handleInput("\t");
			expect(mode.transcriptFocus?.focus).toBe("scrollback");
			editor.handleInput("\x1b[5~");
			editor.handleInput("\x1b[6~");
			expect(scrolled).toEqual([-10, 10]);
			expect(editor.getText()).toBe("keep me");
			expect(mode.transcriptFocus?.focus).toBe("scrollback");
			editor.handleInput("\t");
			expect(mode.transcriptFocus?.focus).toBe("prompt");
			editor.handleInput("\x1b[5~");
			editor.handleInput("\x1b[6~");
			expect(scrolled).toEqual([-10, 10, -10, 10]);
			expect(editor.getText()).toBe("keep me");
			expect(mode.transcriptFocus?.focus).toBe("prompt");
		} finally {
			for (const stop of stops) stop();
			foregroundCommands.onChange = originalOnChange;
			setKeybindings(previous);
		}
	});
});
