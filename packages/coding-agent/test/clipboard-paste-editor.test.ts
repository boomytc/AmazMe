import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, StdinBuffer, TuiMainScreen } from "@amazme/tui";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ChildAgentBook } from "../src/core/child-session.ts";
import { foregroundCommands } from "../src/core/foreground-commands.ts";
import { getClipboardPasteKeys, KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { DashboardView } from "../src/modes/interactive/dashboard.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { ParentTranscript } from "../src/modes/interactive/work-surface.ts";
import { isEmptyTerminalPaste } from "../src/utils/clipboard-paste.ts";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("../src/utils/clipboard.ts", () => ({ ...mocks, copyToClipboard: vi.fn() }));
vi.mock("../src/utils/clipboard-image.ts", async (original) => ({
	...(await original<typeof import("../src/utils/clipboard-image.ts")>()),
	readClipboardImage: mocks.readClipboardImage,
}));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
let directory = "";
const cleanup: Array<() => void> = [];
const prototype = InteractiveMode.prototype as unknown as {
	setupKeyHandlers(this: unknown): void;
	installInteractiveInput(this: unknown): void;
	handleClipboardPaste(this: unknown): Promise<void>;
	handleRightClickPaste(this: unknown): Promise<void>;
	setupEditorSubmitHandler(this: unknown): void;
	dispatchDashboard(this: unknown, text: string, attach: boolean): Promise<void>;
	replyDashboard(this: unknown, id: string, text: string, attach: boolean): Promise<void>;
};

beforeAll(() => initTheme("dark", false));
beforeEach(() => {
	vi.resetAllMocks();
	directory = mkdtempSync(join(tmpdir(), "amazme-paste-test-"));
	vi.stubEnv("TMPDIR", directory);
	vi.stubEnv("TEMP", directory);
	vi.stubEnv("TMP", directory);
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue({ bytes: PNG, mimeType: "image/png" });
	mocks.readClipboardText.mockResolvedValue(null);
	const onChange = foregroundCommands.onChange.bind(foregroundCommands);
	vi.spyOn(foregroundCommands, "onChange").mockImplementation((listener) => {
		const stop = onChange(listener);
		cleanup.push(stop);
		return stop;
	});
});
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function fixture(bindings = new KeybindingsManager()) {
	const terminal = new VirtualTerminal(80, 24);
	const ui = new TuiMainScreen(terminal);
	cleanup.push(() => ui.stop());
	const editor = new CustomEditor(ui, getEditorTheme(), bindings);
	const effects: string[] = [];
	const mode = {
		editor, defaultEditor: editor, keybindings: bindings, ui, renderer: ui,
		dashboardView: undefined as DashboardView | undefined,
		dashboard: (): DashboardView => view,
		handleClipboardPaste: (): Promise<void> => prototype.handleClipboardPaste.call(mode),
		installInteractiveInput: (): void => prototype.installInteractiveInput.call(mode),
		session: { isStreaming: false, childAgents: new ChildAgentBook(), abort: vi.fn(), abortBash: vi.fn() },
		chatContainer: new Container(), editorContainer: new Container(), parentTranscript: new ParentTranscript(),
		footer: { setComposerLine: () => {} },
		ensureWorkSurface: () => {}, updateEditorBorderColor: () => {},
		submitEditorText: vi.fn(), showStatus: vi.fn(), showError: vi.fn(), isBashMode: false,
	};
	const view = new DashboardView({
		exit: () => {}, create: () => {}, openPrevious: () => {}, open: () => {},
		dispatch: (text) => effects.push(`new:${text}`),
		reply: (id, text) => effects.push(`reply:${id}:${text}`),
		rename: () => {}, stop: () => {}, delete: () => {}, status: () => {}, prefs: () => {},
		opened: (open) => ui.setFocus(open ? view : editor),
		focusInput: () => ui.setFocus(editor), focusList: () => ui.setFocus(view),
		paste: (data) => {
			if (!isEmptyTerminalPaste(data) && !bindings.matches(data, "app.clipboard.pasteImage")) return false;
			void mode.handleClipboardPaste();
			return true;
		},
	}, () => [
		{ id: "live", name: "live", cwd: "/repo", state: "idle", activity: "idle", updatedAt: Date.now(), attached: true, lastQuestion: "" },
		{ id: "saved", name: "saved", cwd: "/repo", state: "idle", activity: "idle", updatedAt: Date.now(), attached: false, lastQuestion: "" },
	], () => ({ cwd: "/repo", branch: null }));
	mode.dashboardView = view;
	prototype.setupKeyHandlers.call(mode);
	ui.addChild(view);
	ui.addChild(editor);
	ui.setFocus(editor);
	ui.start();
	return { terminal, ui, editor, view, mode, effects };
}

function pastedFile(): string {
	const files = readdirSync(directory).filter((name) => name.startsWith("amazme-clipboard-"));
	expect(files).toHaveLength(1);
	const file = join(directory, files[0]!);
	expect(readFileSync(file)).toEqual(PNG);
	if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
	return file;
}

test.each(["\x16", "\x1b[118;5u", "\x1b[118;5:2u"])("installed image paste handles legacy and Kitty keys (%j) without sending", async (key) => {
	const { terminal, editor, mode } = fixture();
	await terminal.waitForRender();
	editor.setText("查看后文");
	editor.handleInput("\x01");
	editor.handleInput("\x1b[C");
	editor.handleInput("\x1b[C");
	terminal.sendInput(key);
	await terminal.waitForRender();
	expect(editor.getText()).toBe(`查看 ${pastedFile()} 后文`);
	expect(mode.submitEditorText).not.toHaveBeenCalled();
	expect(mode.session.abort).not.toHaveBeenCalled();
	expect(mode.showError).not.toHaveBeenCalled();
	expect(mocks.readClipboardText).not.toHaveBeenCalled();
});

test.each<{ platform: NodeJS.Platform; env: NodeJS.ProcessEnv; key: string; focus: "main" | "dashboard" }>([
	{ platform: "darwin", env: {}, key: "\x1b[118;9u", focus: "main" },
	{ platform: "darwin", env: {}, key: "\x1b[118;9:2u", focus: "dashboard" },
	{ platform: "win32", env: {}, key: "\x16", focus: "dashboard" },
	{ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, key: "\x1bv", focus: "main" },
	{ platform: "linux", env: {}, key: "\x1b[118;6u", focus: "main" },
])("system paste reaches $focus on $platform with $env", async ({ platform, env, key, focus }) => {
	const bindings = new KeybindingsManager({ "app.clipboard.pasteImage": getClipboardPasteKeys(platform, env) });
	const { terminal, editor, view, mode } = fixture(bindings);
	if (focus === "dashboard") view.toggle();
	await terminal.waitForRender();
	terminal.sendInput(key);
	await terminal.waitForRender();
	const file = pastedFile();
	expect(focus === "main" ? editor.getText() : view.createPasteTarget()?.getText()).toBe(file);
	expect(mode.submitEditorText).not.toHaveBeenCalled();
	expect(mode.session.abort).not.toHaveBeenCalled();
	expect(mode.showError).not.toHaveBeenCalled();
});

test.each(["list", "composer"] as const)("Dashboard paste reaches the selected reply from %s focus", async (focus) => {
	const { terminal, ui, editor, view, effects } = fixture();
	view.toggle();
	if (focus === "composer") ui.setFocus(editor);
	await terminal.waitForRender();
	terminal.sendInput("\x16");
	await terminal.waitForRender();
	const file = pastedFile();
	expect(view.createPasteTarget()?.getText()).toBe(file);
	expect(editor.getText()).toBe("");
	view.handleKey("\r");
	expect(effects).toEqual([`reply:live:${file}`]);
});

test.each(["main", "dashboard-list", "dashboard-composer"] as const)("an image-only terminal paste reaches %s without a key event", async (focus) => {
	const { terminal, ui, editor, view, mode, effects } = fixture();
	if (focus !== "main") view.toggle();
	if (focus === "dashboard-composer") ui.setFocus(editor);
	await terminal.waitForRender();
	const input = new StdinBuffer();
	input.on("paste", (text) => terminal.sendInput(`\x1b[200~${text}\x1b[201~`));
	input.process("\x1b[200~");
	input.process("\x1b[201~");
	input.destroy();
	await terminal.waitForRender();
	const file = pastedFile();
	expect(focus === "main" ? editor.getText() : view.createPasteTarget()?.getText()).toBe(file);
	if (focus !== "main") expect(editor.getText()).toBe("");
	expect(mocks.readClipboardImage).toHaveBeenCalledOnce();
	expect(mode.submitEditorText).not.toHaveBeenCalled();
	expect(effects).toEqual([]);
	expect(mode.session.abort).not.toHaveBeenCalled();
});

test.each(["main", "dashboard"] as const)("nonempty terminal text paste in %s never reads the image clipboard", async (focus) => {
	const { terminal, editor, view } = fixture();
	if (focus === "dashboard") view.toggle();
	await terminal.waitForRender();
	terminal.sendInput("\x1b[200~hello\x1b[201~");
	await terminal.waitForRender();
	expect(focus === "main" ? editor.getText() : view.createPasteTarget()?.getText()).toBe("hello");
	expect(mocks.readClipboardFilePaths).not.toHaveBeenCalled();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("multiline Dashboard text paste stays a draft and cannot submit or navigate", async () => {
	const { terminal, view, effects } = fixture();
	view.toggle();
	await terminal.waitForRender();
	terminal.sendInput("\x1b[200~hello\r\nworld\x1b[201~");
	await terminal.waitForRender();
	expect(view.createPasteTarget()?.getText()).toBe("hello\nworld");
	expect(effects).toEqual([]);
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("terminal image paste cannot write into a hidden parent editor", async () => {
	const { terminal, editor, mode } = fixture();
	mode.session.childAgents.add({
		id: "child", description: "work", modelId: "model", status: "running", activity: "",
		startedAt: Date.now(), transcript: [], cancel: () => {},
	});
	mode.session.childAgents.open("child");
	await terminal.waitForRender();
	terminal.sendInput("\x1b[200~\x1b[201~");
	await terminal.waitForRender();
	expect(editor.getText()).toBe("");
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("custom paste bindings replace defaults and work from Dashboard focus", async () => {
	const { terminal, view } = fixture(new KeybindingsManager({ "app.clipboard.pasteImage": "ctrl+shift+v" }));
	view.toggle();
	await terminal.waitForRender();
	terminal.sendInput("\x16");
	await terminal.waitForRender();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	terminal.sendInput("\x1b[118;6u");
	await terminal.waitForRender();
	expect(view.createPasteTarget()?.getText()).toBe(pastedFile());
});

test("custom Tab paste takes precedence over list focus navigation", async () => {
	const { terminal, ui, view } = fixture(new KeybindingsManager({ "app.clipboard.pasteImage": "tab" }));
	view.toggle();
	await terminal.waitForRender();
	terminal.sendInput("\t");
	await terminal.waitForRender();
	expect(view.createPasteTarget()?.getText()).toBe(pastedFile());
	expect(ui.getFocusedComponent()).toBe(view);
});

test("programmatic Dashboard toggles are not mistaken for a custom paste binding", () => {
	const { view } = fixture(new KeybindingsManager({ "app.clipboard.pasteImage": "ctrl+\\" }));
	view.toggle();
	expect(view.isOpen()).toBe(true);
	view.toggle();
	expect(view.isOpen()).toBe(false);
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test.each(["new", "reply"] as const)("pasted references submit through the real %s handler without re-entering Dashboard dispatch", async (action) => {
	const { view, mode } = fixture();
	view.toggle();
	await mode.handleClipboardPaste();
	const text = view.createPasteTarget()!.getText();
	const context = Object.assign(mode, {
		pendingUserInputs: [] as string[],
		flushPendingBashComponents: vi.fn(),
		syncDashboard: vi.fn(),
		handleClearCommand: vi.fn(async () => {}),
		reloadDashboardDisk: async () => {},
		dashboardAgents: () => [{ id: "live", attached: true }],
	});
	prototype.setupEditorSubmitHandler.call(context);
	if (action === "new") await prototype.dispatchDashboard.call(context, text, false);
	else await prototype.replyDashboard.call(context, "live", text, false);
	expect(context.pendingUserInputs).toEqual([text]);
	expect(context.handleClearCommand).toHaveBeenCalledTimes(action === "new" ? 1 : 0);
	expect(view.isOpen()).toBe(true);
});

test("bash image paths containing spaces are shell-quoted", async () => {
	const { editor, mode } = fixture();
	const spaced = join(directory, "My Photos");
	mkdirSync(spaced);
	vi.stubEnv("TMPDIR", spaced);
	vi.stubEnv("TEMP", spaced);
	vi.stubEnv("TMP", spaced);
	editor.setText("!cat");
	await mode.handleClipboardPaste();
	const file = join(spaced, readdirSync(spaced)[0]!);
	expect(editor.getText()).toBe(`!cat '${file}'`);
	expect(readFileSync(file)).toEqual(PNG);
});

test("Dashboard new-session paste preserves existing text and repeated image paths stay separated", async () => {
	const { view, mode, effects } = fixture();
	view.toggle();
	view.handleKey("\x1b");
	view.createPasteTarget()?.insertTextAtCursor("分析截图");
	await mode.handleClipboardPaste();
	await mode.handleClipboardPaste();
	const files = readdirSync(directory).map((name) => join(directory, name));
	expect(files).toHaveLength(2);
	const draft = view.createPasteTarget()!.getText();
	expect(draft.startsWith("分析截图 ")).toBe(true);
	for (const file of files) expect(draft).toContain(` ${file}`);
	view.handleKey("\r");
	expect(effects).toEqual([`new:${draft}`]);
});

test.each(["selection", "rename", "close"] as const)("an in-flight paste cannot leak after Dashboard %s changes", async (change) => {
	const { view, mode, editor } = fixture();
	view.toggle();
	let resolve!: (image: { bytes: Uint8Array; mimeType: string }) => void;
	mocks.readClipboardImage.mockImplementation(() => new Promise((done) => { resolve = done; }));
	const pending = mode.handleClipboardPaste();
	await vi.waitFor(() => expect(mocks.readClipboardImage).toHaveBeenCalled());
	if (change === "selection") view.handleKey("\x1b[B");
	else if (change === "rename") view.handleKey("\x12");
	else view.forceClose();
	resolve({ bytes: PNG, mimeType: "image/png" });
	await pending;
	expect(readdirSync(directory)).toEqual([]);
	expect(editor.getText()).toBe("");
});

test("plain clipboard text falls back into Dashboard and stays single-line when displayed", async () => {
	const { view, mode } = fixture();
	view.toggle();
	view.handleKey("\x1f");
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue("中文\r\n查询\x1b[31m");
	await mode.handleClipboardPaste();
	expect(view.createPasteTarget()?.getText()).toBe("中文\n查询");
	expect(view.render(80).at(-1)).toContain("Search: 中文 查询");
});

test("right-click on the main composer also reads clipboard images", async () => {
	const { mode, editor } = fixture();
	await prototype.handleRightClickPaste.call(mode);
	expect(editor.getText()).toBe(pastedFile());
	expect(mocks.readClipboardText).not.toHaveBeenCalled();
});

test("a replaced editor does not receive an earlier asynchronous image paste", async () => {
	const { mode } = fixture();
	let resolve!: (image: { bytes: Uint8Array; mimeType: string }) => void;
	mocks.readClipboardImage.mockImplementation(() => new Promise((done) => { resolve = done; }));
	const pending = mode.handleClipboardPaste();
	await vi.waitFor(() => expect(mocks.readClipboardImage).toHaveBeenCalled());
	const replacement = new CustomEditor(mode.ui, getEditorTheme(), new KeybindingsManager());
	mode.editor = replacement;
	resolve({ bytes: PNG, mimeType: "image/png" });
	await pending;
	expect(replacement.getText()).toBe("");
	expect(readdirSync(directory)).toEqual([]);
});
