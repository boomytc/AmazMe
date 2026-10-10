import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@amazme/ai";
import type {
	ConversationId,
	EntryRecord,
	InboxState,
	LiveState,
	TaskGraph,
	TaskGraphNode,
	UsageState,
	SessionEnd,
} from "@amazme/durable";
import {
	Box,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Markdown,
	ScrollView,
	type SelectItem,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	Text,
	TruncatedText,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@amazme/tui";
import { getAgentDir } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { createAllToolRenderers } from "../core/tools/renderers/index.ts";
import { codemodeRenderers } from "../core/codemode/renderer.ts";
import { McpManagerView } from "../core/mcp/view.ts";
import { manageMcp } from "./mcp-menu.ts";
import { AssistantMessageComponent } from "../modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../modes/interactive/components/custom-editor.ts";
import { ListSelector } from "../modes/interactive/components/list-selector.ts";
import { manageProviderAuth } from "./provider-menu.ts";
import { createInteractiveTui } from "../modes/interactive/tui-renderer.ts";
import { DynamicBorder } from "../modes/interactive/components/dynamic-border.ts";
import { formatTokens } from "../modes/interactive/components/footer.ts";
import { keyText } from "../modes/interactive/components/keybinding-hints.ts";
import { type StatusIndicator, WorkingStatusIndicator } from "../modes/interactive/components/status-indicator.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../modes/interactive/components/user-message.ts";
import { getEditorTheme, getMarkdownTheme, initTheme, onThemeChange, setRegisteredThemes, theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceLoader } from "../core/resource-loader.ts";
import { InteractiveThemeController } from "../modes/interactive/theme/theme-controller.ts";
import { agentOf, type DurableController, type DurableView, type DurableViewSource, formatLane } from "./runtime.ts";
import { NATIVE_COMMANDS } from "./commands.ts";
import type { SlashCommandCompletion } from "../core/plugins/slash-commands.ts";

/** Runtime information without sending a local command to the model. */
class InfoPanel extends Container implements Focusable {
	focused = false;
	readonly #close: () => void;

	constructor(title: string, text: string, close: () => void) {
		super();
		this.#close = close;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 1));
		this.addChild(new Text(text, 1, 0));
		this.addChild(new Text(theme.fg("dim", "Esc / Enter to close"), 1, 1));
		this.addChild(new DynamicBorder());
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) this.#close();
	}
}

/** One line of text, for custom branch-summary instructions. */
class LinePrompt extends Container implements Focusable {
	readonly #input = new Input();
	#focused = false;

	constructor(title: string, onSubmit: (value: string) => void, onCancel: () => void) {
		super();
		this.#input.onSubmit = onSubmit;
		this.#input.onEscape = onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(this.#input);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	handleInput(data: string): void {
		this.#input.handleInput(data);
	}
}

/** The summary that replaced earlier context: collapsed to one line until expanded. */
class CompactionComponent extends Box {
	readonly #summary: string;

	constructor(summary: string, expanded: boolean) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.#summary = summary;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.clear();
		this.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[compaction]")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			expanded
				? new Markdown(this.#summary, 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("customMessageText", text),
					})
				: new Text(
						theme.fg("customMessageText", "Earlier context summarized (") +
							theme.fg("dim", keyText("app.tools.expand")) +
							theme.fg("customMessageText", " to expand)"),
						0,
						0,
					),
		);
	}
}

interface Handlers {
	readonly plugins: boolean;
	completeCommand(name: string, prefix: string): Promise<readonly SlashCommandCompletion[] | null>;
	submit(text: string): void;
	followUp(text: string): void;
	abort(): void;
	exit(): void;
	selectModel(): void;
	cycleModel(direction: "forward" | "backward"): void;
	cycleThinking(): void;
}

class DurableTui {
	static readonly #renderers: Record<string, ToolRenderers> = {
		...createAllToolRenderers(),
		codemode: codemodeRenderers,
	};
	readonly #ui: TuiAltScreen | TuiMainScreen;
	readonly #chat = new Container();
	readonly #tasks = new Container();
	readonly #queue = new Container();
	readonly #notices = new Container();
	readonly #footer = new Container();
	readonly #footerStats = new Text("", 1, 0);
	readonly #footerHints = new Text("", 1, 0);
	readonly #editorContainer = new Container();
	readonly #editor: CustomEditor;
	readonly #cwd: string;
	readonly #plugins: boolean;
	readonly #completeCommand: Handlers["completeCommand"];
	#autocompleteCommands: DurableView["commands"] | null = null;
	/** The newest card per call ID; provider call IDs may repeat across turns. */
	readonly #tools = new Map<string, ToolExecutionComponent>();
	/** Every card shown, also older ones whose call ID a later turn reused. */
	readonly #cards: ToolExecutionComponent[] = [];
	/** Call IDs whose cards the streaming answer created; its entry takes them over. */
	readonly #streamingCalls = new Set<string>();
	readonly #summaries: CompactionComponent[] = [];
	/** Tool output and summaries shown in full; toggled like pi. */
	#expanded = false;
	#renderedEntryIds: number[] = [];
	#streaming: AssistantMessageComponent | undefined;
	#indicator: StatusIndicator | undefined;
	#statusText = "";
	/** Set when the transcript was rebuilt: the next render repaints the screen and shows the end. */
	#rebuilt = false;
	#transcript: ScrollView | undefined;

	constructor(cwd: string, handlers: Handlers, settings: SettingsManager) {
		this.#cwd = cwd;
		this.#plugins = handlers.plugins;
		this.#completeCommand = handlers.completeCommand;
		this.#ui = createInteractiveTui({
			tuiMode: settings.getTuiMode(),
			showHardwareCursor: settings.getShowHardwareCursor(),
			logDirectory: getAgentDir(),
			fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
			fullscreenWheelScrollLines: settings.getFullscreenWheelScrollLines(),
		});
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		this.#editor = new CustomEditor(this.#ui, getEditorTheme(), keybindings, {
			paddingX: 1,
			embedWorkingStatus: true,
		});
		this.#editor.onSubmit = handlers.submit;
		this.#editor.setShortcutLine(() => `Enter send · ${keyText("app.message.followUp")} follow-up`);
		this.#editor.onEscape = handlers.abort;
		this.#editor.onCtrlD = handlers.exit;
		this.#editor.onAction("app.clear", handlers.exit);
		this.#editor.onAction("app.model.select", handlers.selectModel);
		this.#editor.onAction("app.model.cycleForward", () => handlers.cycleModel("forward"));
		this.#editor.onAction("app.model.cycleBackward", () => handlers.cycleModel("backward"));
		this.#editor.onAction("app.thinking.cycle", handlers.cycleThinking);
		this.#editor.onAction("app.tools.expand", () => {
			this.#expanded = !this.#expanded;
			for (const component of [...this.#cards, ...this.#summaries]) component.setExpanded(this.#expanded);
			this.#ui.requestRender();
		});
		this.#editor.onAction("app.message.followUp", () => {
			const text = this.#editor.getText().trim();
			if (!text) return;
			this.#editor.setText("");
			handlers.followUp(text);
		});

		this.#editorContainer.addChild(this.#editor);
		this.#footer.addChild(this.#footerStats);
		this.#footer.addChild(this.#footerHints);
		// One empty line between the transcript and everything below it.
		for (const component of [this.#chat, this.#tasks, this.#queue, this.#notices, this.#editorContainer, this.#footer]) {
			this.#ui.addChild(component);
		}
		if (this.#ui instanceof TuiAltScreen) {
			const content = new Container();
			content.addChild(this.#chat);
			content.addChild(new Spacer(1));
			const transcript = new ScrollView(content, { follow: "end", primary: true, overscroll: "chain" });
			this.#transcript = transcript;
			const dock = new VStack([
				{ component: this.#tasks, shrink: 1, minSize: 0 },
				{ component: this.#queue, shrink: 1, minSize: 0 },
				{ component: this.#notices, shrink: 1, minSize: 0 },
				{ component: this.#editorContainer, shrink: 1, minSize: 3 },
				{ component: this.#footer, shrink: 1, minSize: 0 },
			]);
			this.#ui.setLayoutRoot(new VStack([
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]));
		}
		this.#ui.setFocus(this.#editor);
	}

	get ui(): TuiAltScreen | TuiMainScreen {
		return this.#ui;
	}

	start(): void {
		this.#ui.start();
	}

	stop(): void {
		this.#discardTools();
		this.#indicator?.dispose();
		this.#ui.stop();
	}

	/** Finish every card: a running bash card keeps a timer until it gets a final result. */
	#discardTools(): void {
		for (const component of this.#cards) component.updateResult({ content: [], isError: false }, false);
		this.#cards.length = 0;
		this.#tools.clear();
		this.#streamingCalls.clear();
	}

	mount(component: Component): void {
		this.#editorContainer.clear();
		this.#editorContainer.addChild(component);
		this.#ui.setFocus(component);
		this.#ui.requestRender();
	}

	restoreEditor(): void {
		this.mount(this.#editor);
	}

	/** Escape during a branch summary cancels that summary; otherwise it aborts the turn. */
	setEscape(handler: () => void): void {
		this.#editor.onEscape = handler;
	}

	refreshTheme(snapshot: DurableView): void {
		this.#rebuild([...snapshot.history, ...snapshot.conversation.entries]);
		this.#ui.invalidate();
		this.apply(snapshot);
	}

	apply(view: DurableView): void {
		if (this.#autocompleteCommands !== view.commands) {
			this.#autocompleteCommands = view.commands;
			this.#editor.setAutocompleteProvider(new CombinedAutocompleteProvider([
				...NATIVE_COMMANDS.filter(({ name }) => this.#plugins || name !== "plugins"),
				...(view.commands ?? []).map((command) => ({
					...command,
					getArgumentCompletions: async (prefix: string) => {
						const items = await this.#completeCommand(command.name, prefix);
						return items === null ? null : [...items];
					},
				})),
			], this.#cwd));
		}
		const live = (view.conversation.docs["amazme.live"] ?? {}) as LiveState;
		const shown = [...view.history, ...view.conversation.entries];
		this.#syncTranscript(shown);
		const message = live.generation?.message as AssistantMessage | undefined;
		// A partial without its entry was dropped, for example by a retry: render the transcript again.
		if (message === undefined && this.#streaming !== undefined) this.#rebuild(shown);
		if (message !== undefined) this.#syncStreaming(message);
		for (const slot of [...(live.tools ?? []), ...(live.nestedTools ?? [])]) {
			if (slot.status === "pending") continue;
			const key = !("parentCallId" in slot) ? slot.callId : `${slot.taskId}:${slot.callId}`;
			const component = this.#tool(slot.name, slot.callId, "arguments" in slot ? slot.arguments : undefined, false, key);
			component.setArgsComplete();
			if (slot.status !== "running") {
				if ("summary" in slot && slot.summary !== undefined)
					component.updateResult({
						content: slot.summary.error ? [{ type: "text", text: slot.summary.error }] : [],
						isError: slot.summary.isError,
						durationMs: slot.summary.durationMs,
					});
				continue;
			}
			component.markExecutionStarted();
			const child = (slot.details as { conversationId?: number } | undefined)?.conversationId;
			if (slot.output === undefined && child !== undefined) {
				const text = `Subagent ${child} is working. /tree switches to it.`;
				component.updateResult(
					{
						content: [{ type: "text", text }],
						details: slot.details,
						isError: false,
					},
					true,
				);
			} else if (slot.output !== undefined || slot.details !== undefined) {
				component.updateResult(
					{
						content: slot.output === undefined ? [] : [{ type: "text", text: slot.output }],
						details: slot.details,
						isError: false,
					},
					true,
				);
			}
		}
		this.#syncTasks(view.tasks);
		this.#syncQueue((view.conversation.docs["amazme.inbox"] ?? { items: [] }) as InboxState);
		this.#syncNotices(view);
		this.#editor.borderColor = theme.getThinkingBorderColor(agentOf(view.conversation).thinkingLevel ?? "off");
		this.#syncStatus(live);
		this.#syncFooter(view);
		if (this.#rebuilt) this.#transcript?.scrollToEnd();
		this.#ui.requestRender(this.#rebuilt);
		this.#rebuilt = false;
	}

	#syncTasks(graph: TaskGraph | undefined): void {
		this.#tasks.clear();
		if (graph === undefined) return;
		const nodes = Object.values(graph.tasks);
		const lines: string[] = [theme.fg("accent", `Tasks (${nodes.length} live, /tasks to hide)`)];
		// A conversation-owned task sits under the task that owns its conversation, when that task is live.
		const owned = new Set(nodes.flatMap((node) => node.conversations));
		const children = (node: TaskGraphNode) =>
			nodes.filter((candidate) => candidate.owner === node.id || (candidate.owner === undefined && node.conversations.includes(candidate.conversationId)));
		const visit = (node: TaskGraphNode, depth: number): void => {
			lines.push(`${"  ".repeat(depth + 1)}${describeTask(node)}`);
			for (const child of children(node)) visit(child, depth + 1);
		};
		for (const node of nodes) {
			if (node.owner === undefined && !owned.has(node.conversationId)) visit(node, 0);
		}
		for (const line of lines) this.#tasks.addChild(new TruncatedText(theme.fg("muted", line), 1, 0));
	}

	#syncQueue(inbox: InboxState): void {
		this.#queue.clear();
		for (const item of inbox.items) {
			const text = item.mode === "write" ? `<${String(item.entry.kind)}>` : userText(item.content as UserMessage["content"]);
			this.#queue.addChild(new TruncatedText(theme.fg("muted", `[${item.mode}] ${text}`), 1, 0));
		}
	}

	#syncNotices(view: DurableView): void {
		this.#notices.clear();
		for (const item of view.notices.slice(-4)) {
			const color = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
			this.#notices.addChild(new TruncatedText(theme.fg(color, item.message), 1, 0));
		}
	}

	#syncStatus(live: LiveState): void {
		const generation = live.generation;
		const compaction = live.compactions?.[0];
		const runningTool = live.tools?.find((slot) => slot.status === "running");
		let text = "";
		if (generation?.retry !== undefined) {
			text = `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
		} else if (generation?.deferred !== undefined) text = "Waiting for deferred response...";
		else if (compaction !== undefined) {
			text = compaction.retry ? `Retrying ${compaction.reason} compaction (attempt ${compaction.attempt + 1})...` : `Compacting (${compaction.reason})...`;
		} else if (runningTool !== undefined) text = `Running ${runningTool.name}... (esc to abort)`;
		else if (live.run !== undefined) text = "Working... (esc to abort)";
		if (text === this.#statusText) return;
		this.#statusText = text;
		this.#indicator?.dispose();
		this.#indicator = text ? new WorkingStatusIndicator(this.#ui, text, undefined, (part) => this.#editor.borderColor(part)) : undefined;
		this.#editor.setWorkingStatusIndicator(this.#indicator);
	}

	#syncFooter(view: DurableView): void {
		const agent = agentOf(view.conversation);
		const usage = totalUsage(
			(view.conversation.docs["amazme.usage"] ?? {
				models: {},
				tools: {},
			}) as UsageState,
		);
		const stats: string[] = [];
		if (usage.input) stats.push(`↑${formatTokens(usage.input)}`);
		if (usage.output) stats.push(`↓${formatTokens(usage.output)}`);
		if (usage.cacheRead) stats.push(`R${formatTokens(usage.cacheRead)}`);
		if (usage.cacheWrite) stats.push(`W${formatTokens(usage.cacheWrite)}`);
		stats.push(`$${usage.cost.total.toFixed(3)}`);
		const contextWindow = view.models.find((model) => model.provider === agent.model?.provider && model.modelId === agent.model.modelId)?.contextWindow ?? 0;
		if (contextWindow > 0) {
			const tokens = contextTokens(view.conversation.entries);
			const percent = tokens === undefined ? undefined : (tokens / contextWindow) * 100;
			const text = `${percent === undefined ? "?" : percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
			stats.push(percent !== undefined && percent > 90 ? theme.fg("error", text) : text);
		}
		const historyCue = view.history.length === 0 ? "" : view.historyMore ? " · older above" : " · start of history";
		const title = view.session.name === undefined ? "" : `${theme.fg("accent", view.session.name)} · `;
		const storageCue = view.session.directory === undefined ? " · in memory" : "";
		this.#footerStats.setText(
			`${title}${theme.fg(view.lane.role === "main" ? "dim" : "accent", formatLane(view.lane))}${theme.fg("dim", `${historyCue}${storageCue}  ${stats.join(" ")}  ${view.session.cwd}`)}`,
		);
		this.#footerHints.setText(
			theme.fg(
				"dim",
				`/tree  /fork  /older  /agents  /model  /compact  /tasks  /mcp  /login  /reload${this.#plugins ? "  /plugins" : ""}  · ${keyText("app.thinking.cycle")} thinking · ${keyText("app.model.cycleForward")} cycle · ${keyText("app.model.select")} model · ${keyText("app.message.followUp")} follow-up · ${keyText("app.clear")} exit`,
			),
		);
	}

	#syncTranscript(entries: readonly EntryRecord[]): void {
		// Compaction and resets replace the head of the active transcript.
		if (this.#renderedEntryIds.some((id, index) => entries[index]?.id !== id)) this.#rebuild(entries);
		for (const entry of entries.slice(this.#renderedEntryIds.length)) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#rebuild(entries: readonly EntryRecord[]): void {
		this.#chat.clear();
		this.#discardTools();
		this.#summaries.length = 0;
		this.#rebuilt = true;
		this.#renderedEntryIds = [];
		this.#streaming = undefined;
		for (const entry of entries) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#addEntry(entry: EntryRecord): void {
		const message = entry.model?.[0];
		if (entry.kind === "amazme.user" && message?.role === "user") {
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(new UserMessageComponent(userText(message.content)));
		} else if (entry.kind === "amazme.assistant" && message?.role === "assistant") {
			const component = this.#streaming ?? new AssistantMessageComponent();
			if (this.#streaming === undefined) this.#chat.addChild(component);
			this.#streaming = undefined;
			component.updateContent(message, false);
			// Only a tool-calling answer runs its calls; an aborted, failed, or truncated one never does.
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.#streamingCalls.has(content.id);
				// Only cards the stream already showed are kept for calls that never run.
				if (!ran && !streamed) continue;
				const card = this.#tool(content.name, content.id, content.arguments, !streamed);
				card.setArgsComplete();
				if (!ran) {
					const text = "Not run: the answer was interrupted.";
					card.updateResult({ content: [{ type: "text", text }], isError: true }, false);
				}
			}
			this.#streamingCalls.clear();
		} else if (entry.kind === "amazme.tool-result" && message?.role === "toolResult") {
			const result = message as ToolResultMessage;
			this.#tool(result.toolName, result.toolCallId).updateResult(result);
		} else if (entry.kind === "amazme.compaction") {
			const summary = new CompactionComponent(message?.role === "user" ? userText(message.content) : "", this.#expanded);
			this.#summaries.push(summary);
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(summary);
		} else if (entry.kind === "amazme.reset") this.#addText("[new context]");
	}

	#syncStreaming(message: AssistantMessage): void {
		if (this.#streaming === undefined) {
			this.#streaming = new AssistantMessageComponent();
			this.#chat.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#tool(content.name, content.id, content.arguments, !this.#streamingCalls.has(content.id));
			this.#streamingCalls.add(content.id);
		}
	}

	#addText(text: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Text(theme.fg("muted", text), 1, 0));
	}

	/** The card of a call; `fresh` starts a new one for a call ID an earlier turn used. */
	#tool(name: string, callId: string, args?: unknown, fresh = false, key = callId): ToolExecutionComponent {
		const existing = fresh ? undefined : this.#tools.get(key);
		if (existing !== undefined) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(name, callId, args ?? {}, {}, DurableTui.#renderers[name], this.#ui, this.#cwd);
		component.setExpanded(this.#expanded);
		this.#chat.addChild(component);
		this.#cards.push(component);
		this.#tools.set(key, component);
		return component;
	}
}

function describeTask(node: TaskGraphNode): string {
	const state = node.state;
	const status =
		state.status === "waiting"
			? `waiting on ${state.on.join(", ")}`
			: state.status === "completing"
				? `completing (${state.outcome})`
				: `${state.status} ${state.phase}`;
	const flags = [node.background ? "background" : "", node.abortRequested ? "aborting" : ""].filter(Boolean);
	const owned = node.conversations.length > 0 ? ` owns conversation ${node.conversations.join(", ")}` : "";
	return `${node.kind} #${node.id}: ${status}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${owned}`;
}

function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function totalUsage(state: UsageState): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

/** Context size from the newest successful answer after the newest compaction; unknown before one. */
function contextTokens(entries: readonly EntryRecord[]): number | undefined {
	// Kept entries follow the summary in the view but are older than it; only later answers measure the new context.
	const compacted = Math.max(0, ...entries.filter((entry) => entry.kind === "amazme.compaction").map((entry) => entry.id));
	for (const entry of [...entries].reverse()) {
		const message = entry.model?.[0];
		if (entry.id < compacted || entry.kind !== "amazme.assistant" || message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return undefined;
}

export async function runDurableTui(
	source: DurableViewSource,
	controller: DurableController,
	settings: SettingsManager,
	resources: Pick<ResourceLoader, "getThemes">,
	closed?: Promise<SessionEnd>,
): Promise<void> {
	setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
	let registered = resources.getThemes().themes;
	setRegisteredThemes(registered);
	// The system theme until the controller resolves the user's theme against the terminal's colors.
	initTheme();
	let exit = (): void => {};
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	let view!: DurableTui;
	let managingMcp = false;
	let authFlow: { controller: AbortController; done: Promise<void> } | undefined;
	const showAuth = (mode: "login" | "logout", providerId?: string): void => {
		const auth = controller.auth;
		if (!auth || authFlow || managingMcp) return;
		const owner = new AbortController();
		const done = manageProviderAuth(auth, mode, providerId, {
			ui: view.ui,
			mount: (component) => view.mount(component),
			select: (title, items, confirm, cancel) => view.mount(new ListSelector(title, items, confirm, cancel)),
			inform: (text, close) => view.mount(new InfoPanel("Provider authentication", text, close)),
		}, owner.signal).then(() => undefined).finally(() => {
			if (!owner.signal.aborted) view.restoreEditor();
			if (authFlow?.controller === owner) authFlow = undefined;
		});
		authFlow = { controller: owner, done };
	};
	const showMcp = (): void => {
		if (managingMcp || authFlow || controller.mcp === undefined) return;
		managingMcp = true;
		const manager = new McpManagerView(view.ui, theme, KeybindingsManager.create(), settings.getLocalePreference() === "zh");
		view.mount(manager);
		void manageMcp(manager, controller.mcp, settings.getLocalePreference() === "zh").catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error))).finally(() => {
			managingMcp = false;
			view.restoreEditor();
		});
	};

	const selectModel = (): void => {
		const snapshot = source.current();
		const current = agentOf(snapshot.conversation).model;
		const isCurrent = (model: { provider: string; modelId: string }) => model.provider === current?.provider && model.modelId === current.modelId;
		const items: SelectItem[] = [...snapshot.models]
			.sort((left, right) => Number(isCurrent(right)) - Number(isCurrent(left)))
			.map((model) => ({
				value: `${model.provider}/${model.modelId}`,
				label: model.modelId,
				description: model.provider,
			}));
		const selector = new ListSelector(
			"Select model:",
			items,
			(value) => {
				view.restoreEditor();
				const separator = value.indexOf("/");
				void controller.setModel({
					provider: value.slice(0, separator),
					modelId: value.slice(separator + 1),
				});
			},
			() => view.restoreEditor(),
		);
		view.mount(selector);
	};

	const selectConversation = (): void => {
		void (async () => {
			const snapshot = source.current();
			const points = await controller.returnPoints();
			const items: SelectItem[] = [
				...snapshot.conversations.map((candidate) => ({
					value: `focus:${String(candidate.id)}`,
					label: `${"  ".repeat(candidate.depth)}${candidate.label}`,
					description: `${String(candidate.id) === String(snapshot.conversation.conversation.id) ? "shown · " : ""}${candidate.role}`,
				})),
				...points.map((point) => ({
					value: `leave:${point.id}`,
					label: point.label,
					description: "return",
				})),
			];
			const selector = new ListSelector(
				"Switch to:",
				items,
				(value) => {
					view.restoreEditor();
					if (value.startsWith("leave:")) {
						leaveFrom(value.slice("leave:".length));
						return;
					}
					const id = value.startsWith("focus:") ? value.slice("focus:".length) : value;
					void controller.switchConversation(Number(id) as ConversationId);
				},
				() => view.restoreEditor(),
			);
			view.mount(selector);
		})();
	};

	const runLeave = (at: string, summarize: boolean, customInstructions?: string): void => {
		if (summarize) view.setEscape(() => controller.cancelLeave());
		void controller
			.leave(at, {
				summarize,
				...(customInstructions === undefined ? {} : { customInstructions }),
			})
			.finally(() => view.setEscape(() => void controller.abort()));
	};

	const leaveFrom = (at: string): void => {
		if (controller.skipBranchSummaryPrompt()) {
			runLeave(at, false);
			return;
		}
		const selector = new ListSelector(
			"Summarize branch?",
			[
				{ value: "no", label: "No summary" },
				{ value: "yes", label: "Summarize" },
				{ value: "custom", label: "Summarize with custom prompt" },
			],
			(choice) => {
				view.restoreEditor();
				if (choice === "custom") {
					const prompt = new LinePrompt(
						"Custom summarization instructions",
						(text) => {
							view.restoreEditor();
							runLeave(at, true, text);
						},
						() => {
							view.restoreEditor();
							selectConversation();
						},
					);
					view.mount(prompt);
					return;
				}
				runLeave(at, choice === "yes");
			},
			() => {
				view.restoreEditor();
				selectConversation();
			},
		);
		view.mount(selector);
	};

	view = new DurableTui(source.current().session.cwd, {
		plugins: controller.describePlugins !== undefined,
		completeCommand: (name, prefix) => controller.completeCommand?.(name, prefix) ?? Promise.resolve(null),
		submit: (text) => {
			const trimmed = text.trim();
			if (!trimmed) return;
			const authCommand = /^\/(login|logout)(?:\s+(.*))?$/su.exec(trimmed);
			if (authCommand) return showAuth(authCommand[1] === "login" ? "login" : "logout", authCommand[2]?.trim() || undefined);
			if (trimmed === "/mcp") return showMcp();
			if (trimmed === "/plugins" && controller.describePlugins !== undefined) {
				view.mount(new InfoPanel("Plugins", controller.describePlugins(), () => view.restoreEditor()));
				return;
			}
			if (trimmed === "/reload") return void controller.reload();
			if (trimmed === "/model") return selectModel();
			if (trimmed === "/tasks") return void controller.toggleTasks();
			if (trimmed === "/agents" || trimmed === "/tree") return selectConversation();
			if (trimmed === "/fork") return void controller.fork();
			if (trimmed === "/older") return void controller.loadOlder();
			if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
				const instructions = trimmed.slice("/compact".length).trim();
				return void controller.compact(instructions || undefined);
			}
			const invocation = /^\/([a-z0-9][a-z0-9:-]*)(?:\s+(.*))?$/su.exec(trimmed);
			if (invocation !== null && source.current().commands?.some(({ name }) => name === invocation[1])) {
				return void controller.runCommand(invocation[1]!, invocation[2] ?? "");
			}
			void controller.submit(trimmed, "steer");
		},
		followUp: (text) => void controller.submit(text, "followUp"),
		abort: () => void controller.abort(),
		exit,
		selectModel,
		cycleModel: (direction) => void controller.cycleModel(direction),
		cycleThinking: () => void controller.cycleThinking(),
	}, settings);

	// pi's theme handling: the theme setting (also light/dark pairs) resolved against the terminal's reported colors.
	const themes = new InteractiveThemeController(view.ui, {
		getSettingsManager: () => settings,
		showError: (message) => console.error(message),
		onChanged: () => view.ui.requestRender(),
	});
	const unsubscribeTheme = onThemeChange(() => view.refreshTheme(source.current()));
	const unsubscribe = source.subscribe(() => {
		const nextThemes = resources.getThemes().themes;
		if (nextThemes !== registered) {
			registered = nextThemes;
			setRegisteredThemes(registered);
			themes.applyFromSettings();
		}
		view.apply(source.current());
	});
	view.start();
	themes.applyFromSettings();
	view.apply(source.current());
	let end: SessionEnd | undefined;
	try {
		end = await Promise.race([exited.then(() => undefined), ...(closed === undefined ? [] : [closed])]);
	} finally {
		const login = authFlow;
		login?.controller.abort();
		await login?.done;
		unsubscribe();
		unsubscribeTheme();
		themes.dispose();
		setRegisteredThemes(undefined);
		view.stop();
	}
	if (end?.reason === "failed")
		throw new Error("Session failed after a storage error", {
			cause: end.error,
		});
}
