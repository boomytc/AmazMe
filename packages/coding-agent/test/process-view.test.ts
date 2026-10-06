import { Container, getKeybindings, setKeybindings, sliceByColumn, TuiMainScreen, visibleWidth } from "@amazme/tui";
import { fauxAssistantMessage } from "@amazme/ai";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ChildAgentBook } from "../src/core/child-session.ts";
import { foregroundCommands } from "../src/core/foreground-commands.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { InteractiveComposer } from "../src/modes/interactive/composer-contract.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { routeInteractiveInput } from "../src/modes/interactive/interactive-input.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { TranscriptFocus } from "../src/modes/interactive/transcript-focus.ts";
import { ProcessPanel } from "../src/modes/interactive/components/popup-frame.ts";
import { BashRunTable, ParentTranscript, WorkSurface } from "../src/modes/interactive/work-surface.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(ready: () => boolean, label: string): Promise<void> {
	const start = Date.now();
	while (!ready()) {
		if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${label}`);
		await sleep(15);
	}
}

function bashEntries(harness: Awaited<ReturnType<typeof createHarness>>): Array<{ output?: string; exitCode?: number; command?: string }> {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "bashExecution")
		.map((entry) => (entry.type === "message" ? entry.message : undefined))
		.filter((message): message is { output?: string; exitCode?: number; command?: string } => message !== undefined);
}

describe("foreground command presentation", () => {
	test("regular mode drops the click-only badges and the tasks list carries the same actions", () => {
	const previous = getKeybindings();
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	const child = {
		id: "child-1",
		description: "working the task",
		modelId: "model-x",
		status: "running" as const,
		activity: "Thinking",
		startedAt: Date.now(),
		transcript: ["child line"],
		cancel: () => {},
	};
	const book = new ChildAgentBook();
	book.add(child);
	const task = {
		id: "cmd-1",
		command: "sleep 5",
		status: "running" as const,
		output: "hello\nworld",
		exitCode: null,
		pid: 1,
		detached: true,
	};
	let opened = "";
	const surface = new WorkSurface(
		book,
		{ list: () => [task] } as never,
		{
			openProcess: (id) => {
				opened = id;
			},
			closeProcess: () => {},
		},
		{ mouseEnabled: false, emptyDraft: () => true },
	);
	try {
		const rendered = surface.render(80).join("\n");
		expect(rendered).not.toContain("[open]");
		expect(rendered).not.toContain("[close]");
		// No pointer, so the badges are not targets either.
		surface.handleMouse({ type: "click", button: "left", x: 40, y: 1 } as never);
		expect(opened).toBe("");

		// F2 opens the tasks list, which names the keys it answers to.
		surface.handleInput("\x1bOQ");
		expect(book.tasksOpen).toBe(true);
		const tasks = surface.render(80).join("\n");
		expect(tasks).toContain("Tasks");
		expect(tasks).toContain("subagent running working the task");
		expect(tasks).toContain("command running sleep 5");
		expect(tasks).toContain("Enter open");
		expect(tasks).toContain("Escape close");

		// The selection starts on the subagent row and moves to the command row.
		surface.handleInput("\x1b[A");
		surface.handleInput("\r");
		expect(book.openId).toBe("child-1");
		book.close();
		surface.handleInput("\x1b[B");
		surface.handleInput("\r");
		expect(opened).toBe("cmd-1");

		surface.handleInput("\x1b");
		expect(book.tasksOpen).toBe(false);

		// Enter belongs to the composer while the draft holds text.
		const withDraft = new WorkSurface(book, { list: () => [] } as never, undefined, {
			mouseEnabled: false,
			emptyDraft: () => false,
		});
		withDraft.handleInput("\x1bOQ");
		expect(withDraft.book.tasksOpen).toBe(true);
		expect(withDraft.handleInput("\r")).toBe(false);
		withDraft.handleInput("\x1b");
		expect(book.tasksOpen).toBe(false);
	} finally {
		setKeybindings(previous);
	}
});

test("a command that contains the badge text does not move the badge targets", () => {
	const task = {
		id: "cmd-token",
		command: "echo [open] 和 [close] 字面量",
		status: "running" as const,
		output: "out",
		exitCode: null,
		pid: 1,
		detached: true,
	};
	let opened = 0;
	let closed = 0;
	const surface = new WorkSurface(new ChildAgentBook(), { list: () => [task] } as never, {
		openProcess: () => {
			opened += 1;
		},
		closeProcess: () => {
			closed += 1;
		},
	});
	const width = 80;
	const line = surface.render(width).find((item) => item.includes("[open]")) ?? "";
	const tail = "[open] [close]";
	// The badges are right-aligned in the drawn row, so their columns follow from
	// the row width and the tail width alone.
	const openCol = visibleWidth(line) - visibleWidth(tail);
	const closeCol = openCol + "[open] ".length;
	expect(sliceByColumn(line, openCol, "[open]".length)).toBe("[open]");
	expect(sliceByColumn(line, closeCol, "[close]".length)).toBe("[close]");

	// The literal tokens in the command text are not targets.
	const literalCol = line.indexOf("[open]");
	expect(literalCol).toBeLessThan(openCol);
	surface.handleMouse({ type: "click", button: "left", x: literalCol, y: 0 } as never);
	expect([opened, closed]).toEqual([0, 0]);

	surface.handleMouse({ type: "click", button: "left", x: openCol, y: 0 } as never);
	expect(opened).toBe(1);
	surface.handleMouse({ type: "click", button: "left", x: closeCol, y: 0 } as never);
	expect(closed).toBe(1);
});

test("wide rows keep every line inside the terminal and the badges on their drawn columns", () => {
	const description = "分析当前 TUI 实现里还存在的改进点并给出建议";
	const book = new ChildAgentBook();
	book.add({
		id: "child-cjk",
		description,
		modelId: "grok-4.5",
		status: "running",
		activity: "正在阅读 packages/coding-agent 的交互模式源码",
		startedAt: Date.now(),
		transcript: ["结论：中文段落行同样按显示宽度截断，不再有整行溢出", "第二行同样要落在 80 列之内"],
		cancel: () => {},
	});
	const detached = {
		id: "cmd-cjk",
		command: "echo 你好世界并等待一段时间再继续输出后续内容以便观察行宽",
		status: "running" as const,
		output: "你好世界",
		exitCode: null,
		pid: 1,
		detached: true,
	};
	let opened = "";
	let closed = "";
	const surface = new WorkSurface(book, { list: () => [detached] } as never, {
		openProcess: (id) => {
			opened = id;
		},
		closeProcess: (id) => {
			closed = id;
		},
	});
	const width = 80;
	const assertFits = (lines: string[], label: string) => {
		for (const line of lines) {
			expect(visibleWidth(line), `${label} line wider than ${width}: ${line}`).toBeLessThanOrEqual(width);
		}
	};

	// The task rows carry wide glyphs in the description, activity, transcript, and command.
	assertFits(surface.render(width), "task rows");

	const badgeLine = surface.render(width).findIndex((line) => line.includes("[open]"));
	expect(badgeLine).toBeGreaterThanOrEqual(0);
	const badgeText = surface.render(width)[badgeLine] ?? "";
	// Right-aligned badges: the columns follow from the drawn row and tail widths.
	const openCol = visibleWidth(badgeText) - visibleWidth("[open] [close]");
	const closeCol = openCol + "[open] ".length;
	expect(sliceByColumn(badgeText, openCol, "[open]".length)).toBe("[open]");
	expect(sliceByColumn(badgeText, closeCol, "[close]".length)).toBe("[close]");
	surface.handleMouse({ type: "click", button: "left", x: openCol, y: badgeLine } as never);
	surface.handleMouse({ type: "click", button: "left", x: closeCol, y: badgeLine } as never);
	expect(opened).toBe("cmd-cjk");
	expect(closed).toBe("cmd-cjk");

	// The child frame repeats the wide transcript through the same rows.
	book.open("child-cjk");
	assertFits(surface.render(width), "child frame");
	book.close();

	// A large Chinese command line in the foreground row stays inside the width too.
	const foreground = {
		id: "cmd-fg",
		command: "echo 你好世界并等待一段时间再继续输出后续内容以便观察行宽是否溢出终端",
		status: "running" as const,
		output: "正在执行的输出行，包含大量中文字符以便触发行宽检查，确认整行都落在终端宽度之内",
		exitCode: null,
		pid: 2,
		detached: false,
	};
	const foregroundSurface = new WorkSurface(new ChildAgentBook(), { list: () => [foreground] } as never);
	assertFits(foregroundSurface.render(width), "foreground rows");
});

test("regular mode renders wide work-surface rows twice without stopping the renderer", async () => {
	const book = new ChildAgentBook();
	book.add({
		id: "child-cjk",
		description: "分析当前 TUI 实现里还存在的改进点并给出建议",
		modelId: "grok-4.5",
		status: "running",
		activity: "正在阅读 packages/coding-agent 的交互模式源码",
		startedAt: Date.now(),
		transcript: [],
		cancel: () => {},
	});
	const surface = new WorkSurface(book, { list: () => [] } as never);
	const terminal = new VirtualTerminal(80, 24);
	const ui = new TuiMainScreen(terminal);
	ui.addChild(surface);
	const render = ui as unknown as { renderNow(force?: boolean): void; stopped?: boolean };
	try {
		ui.start();
		// First paint, then a diffed paint: the incremental path is where an
		// over-wide line used to abort the renderer.
		render.renderNow(true);
		book.records[0]!.activity = "正在阅读 coding-agent 的交互模式源码与测试文件";
		book.touch();
		render.renderNow();
		render.renderNow();
		await terminal.waitForRender();
		book.close();
		for (const line of surface.render(80)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	} finally {
		ui.stop();
	}
});

test("a background process keeps one row with open and close badges", () => {
		const task = {
			id: "cmd-1",
			command: "sleep 5",
			status: "running" as const,
			output: "hello\nworld",
			exitCode: null,
			pid: 1,
			detached: true,
		};
		let opened = "";
		let closed = "";
		const surface = new WorkSurface(new ChildAgentBook(), { list: () => [task] } as never, {
			openProcess: (id) => {
				opened = id;
			},
			closeProcess: (id) => {
				closed = id;
			},
		});
		const lines = surface.render(80);
		const line = lines.findIndex((item) => item.includes("[open]"));
		expect(line).toBeGreaterThanOrEqual(0);
		expect(lines[line]).toContain("[close]");
		expect(lines.join("\n")).not.toContain("hello");
		const text = lines[line] ?? "";
		surface.handleMouse({ type: "click", button: "left", x: text.indexOf("[open]"), y: line } as never);
		surface.handleMouse({ type: "click", button: "left", x: text.indexOf("[close]"), y: line } as never);
		expect(opened).toBe("cmd-1");
		expect(closed).toBe("cmd-1");

		let panelClosed = 0;
		const panel = new ProcessPanel(() => task, () => {
			panelClosed += 1;
		});
		const top = stripAnsi(panel.render(40)[0] ?? "");
		expect(top.endsWith("[x]╮")).toBe(true);
		expect(panel.render(40).join("\n")).toContain("hello");
		panel.handleMouse({ type: "click", button: "left", x: top.lastIndexOf("[x]"), y: 0 } as never);
		expect(panelClosed).toBe(1);
	});

	beforeAll(() => initTheme("dark"));

	test("streams a local command, backgrounds it without killing it, and reports completion", async () => {
		const harness = await createHarness();
		foregroundCommands.reset();
		const previous = getKeybindings();
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editor = new CustomEditor(ui, getEditorTheme(), keybindings);
		const composer = new InteractiveComposer(editor, {
			isTurnRunning: () => harness.session.isStreaming,
			send: () => {},
			queue: () => {},
			sendQueued: () => {},
			cancelAndSend: () => {},
			cancelTurn: () => {},
			showEscHint: () => {},
			background: () => foregroundCommands.backgroundCurrent(),
		});
		const surface = new WorkSurface(harness.session.childAgents, foregroundCommands);
		editor.onBeforeInput = (data) =>
			routeInteractiveInput(data, {
				child: surface,
				transcript: new TranscriptFocus(() => {}, () => []),
				composer,
			});
		const tool = createBashTool(harness.tempDir);
		const command =
			"node -e \"process.stdout.write('stream-line\\n'); setTimeout(() => process.exit(0), 900)\"";
		const textOf = (content: Array<{ type: string; text?: string }>) =>
			content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
		let streamed = "";
		const running = tool.execute("bash-1", { command }, undefined, (update) => {
			for (const part of update.content ?? []) {
				if (part.type === "text" && part.text) streamed += part.text;
			}
		});
		let chordStreamed = "";
		let chord: Promise<Awaited<ReturnType<typeof tool.execute>>> | undefined;
		let userRun: Promise<unknown> | undefined;
		try {
			await waitFor(() => streamed.includes("stream-line"), "streamed output");
			expect(alive(foregroundCommands.runningPid())).toBe(true);
			const shown = surface.render(120).join("\n");
			expect(shown).toContain("Command running:");
			expect(shown).toContain("stream-line");

			harness.setResponses([fauxAssistantMessage("ack"), fauxAssistantMessage("ack again")]);
			const prompted = harness.session.prompt("continue while it runs");
			const backgrounded = await running;
			expect(textOf(backgrounded.content)).toContain("Command running in the background");
			expect(alive(foregroundCommands.runningPid())).toBe(true);
			await prompted;

			await waitFor(
				() => bashEntries(harness).some((message) => message.output?.includes("stream-line") && message.exitCode === 0),
				"completion in the session",
			);

			chord = tool.execute("bash-2", { command }, undefined, (update) => {
				for (const part of update.content ?? []) {
					if (part.type === "text" && part.text) chordStreamed += part.text;
				}
			});
			await waitFor(() => chordStreamed.includes("stream-line"), "second stream");
			const pid = foregroundCommands.runningPid();
			editor.handleInput("\x02");
			expect(alive(pid)).toBe(true);
			expect(textOf((await chord).content)).toContain("Command running in the background");
			expect(alive(pid)).toBe(true);
			await waitFor(() => foregroundCommands.list().filter((task) => task.status === "completed").length >= 2, "both completions");
			const pinned = surface.render(200).join("\n");
			expect(pinned).not.toContain("Task completed");
			expect(pinned).not.toContain("setTimeout");

			surface.book.tasksOpen = true;
			const tasks = surface.render(200).join("\n");
			expect(tasks).toContain("command completed");
			expect(tasks).toContain("stream-line");

			const appended: Array<{ output: string; exitCode: number | undefined }> = [];
			const stopEvents = harness.session.subscribe((event) => {
				if (
					event.type === "entry_appended" &&
					event.entry.type === "message" &&
					event.entry.message.role === "bashExecution"
				) {
					appended.push({ output: event.entry.message.output, exitCode: event.entry.message.exitCode });
				}
			});
			const userBash = new BashExecutionComponent(command, ui);
			let userChunks = "";
			userRun = harness.session.executeBash(command, (chunk) => {
				userChunks += chunk;
				userBash.appendOutput(chunk);
			});
			await waitFor(() => userChunks.includes("stream-line"), "user bash stream");
			editor.handleInput("\x02");
			const userResult = await userRun;
			expect(userResult.backgrounded).toBe(true);
			userBash.setBackgrounded();
			expect(userBash.isBackgrounded()).toBe(true);
			expect(alive(foregroundCommands.runningPid())).toBe(true);
			const backgroundText = userBash.render(80).join("\n");
			expect(backgroundText).toContain("Running in background");
			expect(backgroundText).toContain("stream-line");
			await waitFor(() => appended.some((message) => message.output.includes("stream-line")), "bash entry");
			const finished = appended.find((message) => message.output.includes("stream-line"));
			userBash.finishBackground(finished?.output ?? "", finished?.exitCode);
			expect(userBash.isBackgrounded()).toBe(false);
			const finishedText = userBash.render(80).join("\n");
			expect(finishedText).toContain("stream-line");
			expect(finishedText).not.toContain("Running in background");
			stopEvents();
		} finally {
			const pid = foregroundCommands.runningPid();
			if (pid !== undefined) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// already exited
					}
				}
			}
			await running.catch(() => undefined);
			await chord?.catch(() => undefined);
			await userRun?.catch(() => undefined);
			harness.cleanup();
			foregroundCommands.reset();
			setKeybindings(previous);
		}
	});

	test("a delayed bash completion reuses the mounted block after the streaming field is cleared", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const chat = new Container();
		const pending = new Container();
		const surface = new WorkSurface(new ChildAgentBook(), { list: () => [] } as never);
		const parentTranscript = new ParentTranscript();
		parentTranscript.bind(chat, surface);
		const runs = new BashRunTable();
		const present = Reflect.get(InteractiveMode.prototype, "presentBashCompletion") as (message: {
			role: "bashExecution";
			command: string;
			output: string;
			exitCode: number;
			cancelled: boolean;
			truncated: boolean;
			timestamp: number;
		}) => void;
		const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (message: {
			role: "bashExecution";
			command: string;
			output: string;
			exitCode: number;
			cancelled: boolean;
			truncated: boolean;
			timestamp: number;
		}) => void;
		const text = (component: { render(width: number): string[] }) => component.render(80).join("\n");
		const live = new BashExecutionComponent("echo hi", ui);
		live.appendOutput("hi\n");
		pending.addChild(live);
		runs.mount(live);
		live.setComplete(0, false);
		const mode = {
			ui,
			bashRuns: runs,
			parentTranscript,
			pendingMessagesContainer: pending,
			pendingBashComponents: [] as BashExecutionComponent[],
			chatContainer: chat,
			addMessageToChat,
		};
		present.call(mode, {
			role: "bashExecution",
			command: "echo hi",
			output: "hi\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		expect(text(chat)).not.toContain("echo hi");
		expect(pending.children.filter((child) => child === live)).toHaveLength(1);

		const background = new BashExecutionComponent("sleep 5", ui);
		background.setBackgrounded();
		pending.addChild(background);
		runs.mount(background);
		present.call(mode, {
			role: "bashExecution",
			command: "echo other",
			output: "other\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 2,
		});
		expect(text(chat)).toContain("echo other");
		expect(text(chat)).toContain("other");
		expect(background.isBackgrounded()).toBe(true);
		expect(text(background)).toContain("Running in background");

		const dropped = new BashExecutionComponent("echo dropped", ui);
		dropped.appendOutput("gone\n");
		chat.addChild(dropped);
		runs.mount(dropped);
		dropped.setComplete(0, false);
		parentTranscript.replaceAll([]);
		expect(text(chat)).not.toContain("echo dropped");
		expect(parentTranscript.contains(dropped)).toBe(false);
		present.call(mode, {
			role: "bashExecution",
			command: "echo dropped",
			output: "landed-after-compact\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 4,
		});
		expect(text(chat)).toContain("echo dropped");
		expect(text(chat)).toContain("landed-after-compact");
		expect(text(dropped)).toContain("gone");
		expect(text(dropped)).not.toContain("landed-after-compact");
		expect(parentTranscript.contains(dropped)).toBe(false);
		expect(parentTranscript.list().some((entry) => text(entry).includes("landed-after-compact"))).toBe(true);
		expect(background.isBackgrounded()).toBe(true);
		expect(text(background)).toContain("Running in background");

		present.call(mode, {
			role: "bashExecution",
			command: "sleep 5",
			output: "sleep-finished-output\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 3,
		});
		expect(background.isBackgrounded()).toBe(false);
		expect(text(background)).toContain("sleep-finished-output");
		expect(text(background)).not.toContain("Running in background");
		expect(text(chat)).not.toContain("sleep 5");
		expect(text(chat)).toContain("landed-after-compact");
		expect(pending.children.filter((child) => child === background)).toHaveLength(1);
	});

	test("a dropped run appends its own row and leaves a newer block of the same command running", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const chat = new Container();
		const pending = new Container();
		const surface = new WorkSurface(new ChildAgentBook(), { list: () => [] } as never);
		const parentTranscript = new ParentTranscript();
		parentTranscript.bind(chat, surface);
		const runs = new BashRunTable();
		const present = Reflect.get(InteractiveMode.prototype, "presentBashCompletion") as (message: {
			role: "bashExecution";
			command: string;
			output: string;
			exitCode: number;
			cancelled: boolean;
			truncated: boolean;
			timestamp: number;
		}) => void;
		const text = (component: { render(width: number): string[] }) => component.render(80).join("\n");
		const dropped = new BashExecutionComponent("sleep 5", ui);
		dropped.setBackgrounded();
		dropped.appendOutput("old-preview\n");
		chat.addChild(dropped);
		runs.mount(dropped);
		parentTranscript.replaceAll([]);
		const newer = new BashExecutionComponent("sleep 5", ui);
		newer.setBackgrounded();
		newer.appendOutput("new-preview\n");
		pending.addChild(newer);
		runs.mount(newer);
		const mode = {
			ui,
			bashRuns: runs,
			parentTranscript,
			pendingMessagesContainer: pending,
			pendingBashComponents: [dropped, newer],
			chatContainer: chat,
			addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat"),
		};
		present.call(mode, {
			role: "bashExecution",
			command: "sleep 5",
			output: "old-finished-output\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		expect(text(chat)).toContain("old-finished-output");
		expect(text(chat)).not.toContain("Running in background");
		expect(newer.isBackgrounded()).toBe(true);
		expect(text(newer)).toContain("Running in background");
		expect(text(newer)).toContain("new-preview");
		expect(text(newer)).not.toContain("old-finished-output");
		expect(text(dropped)).not.toContain("old-finished-output");
		expect(parentTranscript.contains(dropped)).toBe(false);
		expect(pending.children.filter((child) => child === newer)).toHaveLength(1);
		expect(mode.pendingBashComponents).toEqual([newer]);
	});

	test("clearing the pending list does not draw the background block again after completion", () => {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const chat = new Container();
		const pending = new Container();
		const surface = new WorkSurface(new ChildAgentBook(), { list: () => [] } as never);
		const parentTranscript = new ParentTranscript();
		parentTranscript.bind(chat, surface);
		const runs = new BashRunTable();
		const block = new BashExecutionComponent("sleep 5", ui);
		block.setBackgrounded();
		block.appendOutput("stream-line\n");
		pending.addChild(block);
		runs.mount(block);
		const pendingBashComponents = [block];
		const mode = {
			ui,
			bashRuns: runs,
			parentTranscript,
			pendingMessagesContainer: pending,
			pendingBashComponents,
			chatContainer: chat,
			compactionQueuedMessages: [] as Array<{ text: string; mode: "steer" | "followUp" }>,
			session: {
				getSteeringMessages: () => [] as string[],
				getFollowUpMessages: () => [] as string[],
			},
			getAllQueuedMessages: Reflect.get(InteractiveMode.prototype, "getAllQueuedMessages"),
			addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat"),
		};
		const updatePending = Reflect.get(InteractiveMode.prototype, "updatePendingMessagesDisplay") as () => void;
		const present = Reflect.get(InteractiveMode.prototype, "presentBashCompletion") as (message: {
			role: "bashExecution";
			command: string;
			output: string;
			exitCode: number;
			cancelled: boolean;
			truncated: boolean;
			timestamp: number;
		}) => void;
		const flush = Reflect.get(InteractiveMode.prototype, "flushPendingBashComponents") as () => void;
		const text = (component: { render(width: number): string[] }) => component.render(80).join("\n");
		updatePending.call(mode);
		expect(pending.children.includes(block)).toBe(false);
		present.call(mode, {
			role: "bashExecution",
			command: "sleep 5",
			output: "finished-output\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		});
		flush.call(mode);
		const rendered = text(chat);
		expect(rendered).toContain("finished-output");
		expect(rendered).toContain("sleep 5");
		expect(rendered).not.toContain("Running in background");
		const rows = parentTranscript.list().filter((entry) => text(entry).includes("sleep 5"));
		expect(rows).toHaveLength(1);
		expect(text(rows[0] ?? block)).not.toContain("Running in background");
		expect(mode.pendingBashComponents).toEqual([]);
	});
});
