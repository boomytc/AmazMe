/// <reference lib="dom" />
/**
 * Thin DOM renderer: it turns the pure view model into the page's shell markup and owns no
 * business state of its own. Stable blocks retain their DOM; changed blocks retain the reader's
 * selection, focus and viewport position. Disclosure choices belong to this page.
 */
import { COMPACT_ACTION, DOCK_TAB_ACTION, DOCK_TOGGLE_ACTION, HISTORY_MORE_ACTION, MODEL_CONNECTIONS_ACTION, MODEL_SCOPE_ACTION, SESSION_COPY_ID_ACTION, SESSION_RENAME_ACTION, SUBMIT_MODE_ACTION, TRANSCRIPT_SEARCH_ACTION, WELCOME_SESSION_ACTION } from "./actions.ts";
import type { DockTabId } from "./dock.ts";
import { credentialRanges } from "./credentials.ts";
import { createModelPicker } from "./model-picker.ts";
import { createModelConnections } from "./model-connections.ts";
import { COMPOSER_PROJECT_ACTION, PROJECT_ADD_ACTION, PROJECT_SELECT_ACTION, PROJECT_EDIT_ACTION, PROJECT_NEW_SESSION_ACTION, PROJECT_REMOVE_ACTION, SESSION_ARCHIVE_ACTION, SESSION_RESTORE_ACTION } from "./projects.ts";
import { createDirectoryField, type DirectoryListing } from "./directories.ts";
import { errorMessageCopy } from "./errors.ts";
import { DomCache, reconcileChildren, sameViewValue } from "./dom-cache.ts";
import { transcriptPosition } from "./transcript-position.ts";
import { processGroups, type ProcessGroup } from "./process-groups.ts";
import { createMultiselect } from "./multiselect.ts";
import { createFileBrowser } from "./file-browser.ts";
import { createReadingControls } from "./reading-controls.ts";
import { FALLBACK_LOCALE, type Locale } from "./locale.ts";
import { formatMarkdown, tokenizeCode, type InlineNode, type MarkdownNode, type TableAlignment, type TableNode } from "./markdown.ts";
import { insertDraftText, quotedDraft } from "./quote.ts";
import {
	CHAT_VIEW,
	type NavItem,
	type PanelAction,
	type PanelButton,
	type PanelControl,
	type PanelGroup,
	type PanelInput,
	type PanelModal,
	type PanelNotice,
	type PanelPending,
	type PanelRow,
	type PanelSkeleton,
	type PanelSpec,
	searchSettings,
	SETTINGS_FIELD_ACTION,
	SETTINGS_VIEW,
	type SettingsSearchHit,
} from "./panels.ts";
import { fontSizeShortcut, isApplePlatform, isStopChord, matchShortcut, type ShortcutGesture, type ShortcutId } from "./shortcuts.ts";
import { applyTypography, DEFAULT_TYPOGRAPHY, FONT_FAMILY_FIELDS, normalizeFontFamily, resolveTypography } from "./typography.ts";
import { type MessageKey, translate } from "./strings.ts";
import {
	type Attachment,
	composerPlaceholder,
	type QueueItem,
	type RosterItem,
	rosterGroups,
	type TranscriptBlock,
	type WebView,
	type WelcomeCard,
	transcriptSearchHits,
	windowTitle,
} from "./view.ts";

export interface PageElements {
	readonly connection: HTMLElement;
	readonly connectionStatus: HTMLElement;
	readonly connectionStatusText: HTMLElement;
	readonly sessionTitle: HTMLElement;
	readonly sessionWarning: HTMLElement;
	readonly laneStatus: HTMLElement;
	/** The persistent navigation rail and its settings entry. */
	readonly nav: HTMLElement;
	readonly settingsButton: HTMLButtonElement;
	readonly sessionSidebar: HTMLElement;
	readonly sectionSidebar: HTMLElement;
	readonly sectionTitle: HTMLElement;
	readonly sectionNav: HTMLElement;
	/** The settings sidebar's search field. Other management pages leave it hidden. */
	readonly sectionSearch: HTMLElement;
	readonly sectionSearchInput: HTMLInputElement;
	readonly sectionSearchClear: HTMLButtonElement;
	/** The sidebar and the control that collapses it. */
	readonly sidebar: HTMLElement;
	readonly sidebarToggle: HTMLButtonElement;
	/** The main column. Its state (`data-state`) drives the empty layout. */
	readonly center: HTMLElement;
	readonly roster: HTMLElement;
	readonly newChat: HTMLButtonElement;
	readonly composerContext: HTMLElement;
	readonly transcript: HTMLElement;
	readonly transcriptLatest?: HTMLButtonElement;
	readonly column: HTMLElement;
	/** The management panel's host, its back control, and the composer the panel replaces. */
	readonly view: HTMLElement;
	readonly viewBody: HTMLElement;
	readonly viewBack: HTMLButtonElement;
	readonly composerDock: HTMLElement;
	readonly modalRoot: HTMLDialogElement;
	readonly queue: HTMLElement;
	readonly composer: HTMLFormElement;
	readonly prompt: HTMLTextAreaElement;
	/** Send. Stopping a turn is the separate stop control, not this button. */
	readonly primary: HTMLButtonElement;
	/** Stops the running turn. Hidden while the session is idle. */
	readonly stop: HTMLButtonElement;
	/** Pending approvals. Always in the header, beside the usage figures. */
	readonly approvalStatus: HTMLElement;
	/** In-conversation search bar; the settings sidebar owns its own field. */
	readonly transcriptSearch: HTMLElement;
	readonly transcriptSearchInput: HTMLInputElement;
	readonly transcriptSearchCount: HTMLElement;
	readonly transcriptSearchClose: HTMLButtonElement;
	/** Context %, tokens, and cost. Always in the header. */
	readonly meter: HTMLElement;
	readonly meterContext: HTMLElement;
	readonly meterTokens: HTMLElement;
	readonly meterCost: HTMLElement;
	/** The session dock: its tabs and the panel the open tab shows. */
	readonly dock: HTMLElement;
	readonly dockTabs: HTMLElement;
	readonly dockBody: HTMLElement;
	/** The tool calls waiting for a decision, filled by the renderer. */
	readonly approvals: HTMLElement;
	/** The composer's command palette, filled by the renderer. */
	readonly palette: HTMLElement;
	/** The header's run controls (compaction), filled by the renderer. */
	readonly runActions: HTMLElement;
	/** The composer's submit-mode toggle, filled while a turn runs. */
	readonly submitModes: HTMLElement;
	/** The roster's filter. It stays an icon in the brand row until opened. */
	readonly rosterFilterField: HTMLElement;
	readonly rosterFilterToggle: HTMLButtonElement;
	readonly rosterFilter: HTMLInputElement;
	readonly attachments: HTMLElement;
	readonly attach: HTMLButtonElement;
	readonly fileInput: HTMLInputElement;
	/** The scoped model and supported thinking selectors. */
	readonly modelSetup?: HTMLElement;
	readonly modelSelect: HTMLSelectElement;
	readonly thinkingSelect: HTMLSelectElement;
}

/** Host diagnostics may be literal; connection status copy follows the current locale. */
type ConnectionText = string | ((locale: Locale) => string);
type ConnectionState = "connecting" | "connected" | "disconnected";

export interface PageRenderer {
	render(view: WebView): void;
	/** Show an action diagnostic without changing the rail's connectivity indicator. */
	setConnection(text: ConnectionText, kind: "state" | "error", label?: ConnectionText): void;
	/** Show connectivity on the brand mark and clear stale action diagnostics. */
	setConnectionState(text: ConnectionText, state: ConnectionState): void;
	/** Handlers the page entry fills in once it can drive the host. */
	onSelect: (sessionId: string) => void;
	onCreateSession: () => void;
	onBrowseDirectories?: (path?: string) => Promise<DirectoryListing>;
	onPickDirectories?: () => Promise<readonly string[] | undefined>;
	onSubmit: (text: string) => void;
	onAbort: () => void;
	onSelectModel: (provider: string, modelId: string) => void;
	onSelectThinking: (level: string) => void;
	/** Images the reader picked, pasted, or dropped; reading them is the page's job. */
	onAttachFiles: (files: readonly File[]) => void;
	/** The roster's filter text; the page owns it so it survives a repaint. */
	onFilterRoster: (text: string) => void;
	/** A shortcut fired: the page turns it into its action. */
	onShortcut: (id: ShortcutId) => void;
	/** The palette's highlighted row changed, so the page can re-render it. */
	onPaletteSelection: (index: number) => void;
	/** The composer's draft, so the page can project the command palette from it. */
	onDraftChange: (draft: string) => void;
	onDismissSuggestion: () => void;
	/** The reader picked a palette row: the composer takes its text. */
	onCommandPick: (value: string) => void;
	/** Put text in the composer, the way a completion does. */
	setDraft(text: string, focus?: boolean): void;
	/** Insert text at the composer's remembered cursor without replacing the draft. */
	insertDraft(text: string, focus?: boolean): void;
	/** Every navigation, control, and modal report from the management surface. */
	onPanelAction: (action: PanelAction) => void;
	/** Search newly mounted history; only a successful page load may request the remaining pages. */
	refreshTranscriptSearch(options?: { readonly loadHistory?: boolean }): void;
	/** The view the composer's enabled state and placeholder were last rendered from. */
	readonly view: WebView | undefined;
}

export function collectPageElements(): PageElements {
	return {
		connection: pick("connection"),
		connectionStatus: pick("connection-status"),
		connectionStatusText: pick("connection-status-text"),
		sessionTitle: pick("session-title"),
		sessionWarning: pick("session-warning"),
		laneStatus: laneStatusElement(),
		nav: pick("nav"),
		settingsButton: pickElement("settings-button", HTMLButtonElement),
		sessionSidebar: pick("session-sidebar"),
		sectionSidebar: pick("section-sidebar"),
		sectionTitle: pick("section-title"),
		sectionNav: pick("section-nav"),
		sectionSearch: pick("section-search"),
		sectionSearchInput: pickElement("section-search-input", HTMLInputElement),
		sectionSearchClear: pickElement("section-search-clear", HTMLButtonElement),
		sidebar: pick("sidebar"),
		sidebarToggle: pickElement("sidebar-toggle", HTMLButtonElement),
		center: pick("center"),
		roster: pick("roster"),
		transcript: pick("transcript"),
		transcriptLatest: transcriptLatestElement(pick("transcript")),
		column: pick("column"),
		view: pick("view"),
		viewBody: pick("view-body"),
		viewBack: pickElement("view-back", HTMLButtonElement),
		runActions: pick("run-actions"),
		palette: pick("command-palette"),
		approvals: pick("approvals"),
		dock: pick("dock"),
		dockTabs: pick("dock-tabs"),
		dockBody: pick("dock-body"),
		rosterFilterField: pick("roster-filter-field"),
		rosterFilterToggle: pickElement("roster-filter-toggle", HTMLButtonElement),
		rosterFilter: pickElement("roster-filter", HTMLInputElement),
		attachments: pick("attachments"),
		attach: pickElement("attach", HTMLButtonElement),
		fileInput: pickElement("file-input", HTMLInputElement),
		composerDock: pick("composer-dock"),
		newChat: pickElement("new-chat", HTMLButtonElement),
		composerContext: pick("composer-context"),
		modalRoot: pickElement("modal-root", HTMLDialogElement),
		queue: pick("queue"),
		composer: pickElement("composer", HTMLFormElement),
		prompt: pickElement("prompt", HTMLTextAreaElement),
		primary: pickElement("primary", HTMLButtonElement),
		stop: pickElement("stop", HTMLButtonElement),
		approvalStatus: pick("approval-status"),
		transcriptSearch: pick("transcript-search"),
		transcriptSearchInput: pickElement("transcript-search-input", HTMLInputElement),
		transcriptSearchCount: pick("transcript-search-count"),
		transcriptSearchClose: pickElement("transcript-search-close", HTMLButtonElement),
		meter: pick("status-meter"),
		meterContext: pick("meter-context"),
		meterTokens: pick("meter-tokens"),
		meterCost: pick("meter-cost"),
		submitModes: pick("submit-modes"),
		modelSetup: modelSetupElement(pickElement("model-select", HTMLSelectElement)),
		modelSelect: pickElement("model-select", HTMLSelectElement),
		thinkingSelect: pickElement("thinking-select", HTMLSelectElement),
	};
}

function modelSetupElement(modelSelect: HTMLSelectElement): HTMLElement {
	const existing = document.getElementById("model-setup");
	if (existing !== null) return existing;
	const setup = document.createElement("div");
	setup.id = "model-setup";
	setup.className = "model-setup";
	setup.hidden = true;
	modelSelect.insertAdjacentElement("beforebegin", setup);
	return setup;
}

function transcriptLatestElement(transcript: HTMLElement): HTMLButtonElement {
	const existing = document.getElementById("transcript-latest");
	if (existing instanceof HTMLButtonElement) return existing;
	const jump = document.createElement("div");
	jump.className = "transcript-jump";
	const control = document.createElement("button");
	control.type = "button";
	control.id = "transcript-latest";
	control.className = "transcript-latest";
	control.hidden = true;
	jump.append(control);
	transcript.insertAdjacentElement("afterend", jump);
	return control;
}

function laneStatusElement(): HTMLElement {
	const existing = document.getElementById("lane-status");
	if (existing !== null) return existing;
	const lane = document.createElement("span");
	lane.id = "lane-status";
	lane.className = "lane-status";
	lane.hidden = true;
	pick("session-title").insertAdjacentElement("afterend", lane);
	return lane;
}

function pick(id: string): HTMLElement {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`Page document is missing #${id}`);
	return found;
}

function pickElement<T extends HTMLElement>(id: string, constructor: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof constructor)) throw new Error(`Page document is missing #${id}`);
	return found;
}

function element(tag: string, className: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(className: string): HTMLButtonElement {
	const node = document.createElement("button");
	node.type = "button";
	node.className = className;
	return node;
}

/** One flow item: a classed group around a single child. */
function wrap(className: string, child: HTMLElement): HTMLElement {
	const group = element("div", className);
	group.append(child);
	return group;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The icons the page draws. Each names one symbol in the document's sprite (`index.html`). */
type IconName =
	| "square-pen"
	| "package"
	| "sparkles"
	| "clock"
	| "sliders"
	| "message"
	| "home"
	| "settings"
	| "panel-left"
	| "panel-right"
	| "folder"
	| "file"
	| "terminal"
	| "activity"
	| "git-fork"
	| "minimize"
	| "arrow-left"
	| "arrow-up"
	| "plus"
	| "stop"
	| "copy"
	| "more"
	| "check"
	| "x"
	| "thumb-up"
	| "thumb-down"
	| "chevron-down"
	| "search"
	| "wrench"
	| "spinner"
	| "alert";

/** A `use` of one sprite symbol. The class on it sets the colour, which is how the pixel mark's two letters differ. */
function useOf(symbol: string, className: string): SVGUseElement {
	const use = document.createElementNS(SVG_NAMESPACE, "use");
	use.setAttribute("href", `#${symbol}`);
	use.setAttribute("class", className);
	return use;
}

/** The product's pixel AM: a coral A and a yellow M, the mark the terminal header draws too. */
function pixelLogo(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("class", "pixel-logo");
	svg.setAttribute("viewBox", "0 0 10 4");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	svg.append(useOf("i-logo-a", "pixel-a"), useOf("i-logo-m", "pixel-m"));
	return svg;
}

/** One icon: a `use` of its sprite symbol. The stylesheet sets its size and colour. */
function icon(name: IconName, className = "icon"): SVGSVGElement {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("class", className);
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	const use = document.createElementNS(SVG_NAMESPACE, "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

/**
 * The formatted-answer adapter: the pure markdown nodes become DOM, and model text reaches the
 * document only through `textContent` / text nodes. No model string is ever markup.
 */
function inlineFragment(nodes: readonly InlineNode[]): DocumentFragment {
	const fragment = document.createDocumentFragment();
	for (const node of nodes) {
		switch (node.kind) {
			case "text":
				fragment.append(document.createTextNode(node.text));
				break;
			case "code":
				fragment.append(element("code", "md-inline-code", node.text));
				break;
			case "strong": {
				const strong = document.createElement("strong");
				strong.append(inlineFragment(node.children));
				fragment.append(strong);
				break;
			}
			case "em": {
				const em = document.createElement("em");
				em.append(inlineFragment(node.children));
				fragment.append(em);
				break;
			}
			case "link": {
				const link = document.createElement("a");
				link.setAttribute("href", node.href);
				link.setAttribute("target", "_blank");
				link.setAttribute("rel", "noreferrer noopener");
				link.append(inlineFragment(node.children));
				fragment.append(link);
				break;
			}
		}
	}
	return fragment;
}

/** What the markdown adapter needs from the renderer: a code block's copy control. */
interface MarkdownContext {
	readonly copy: (key: MessageKey) => string;
	readonly codeBlock: (text: string, language: string | undefined, index?: number) => HTMLElement;
}

function markdownNode(node: MarkdownNode, context: MarkdownContext, codeIndex = 0): HTMLElement {
	switch (node.kind) {
		case "paragraph": {
			const paragraph = document.createElement("p");
			paragraph.append(inlineFragment(node.children));
			return paragraph;
		}
		case "heading": {
			const heading = document.createElement(`h${Math.min(Math.max(node.level, 1), 6)}`);
			heading.append(inlineFragment(node.children));
			return heading;
		}
		case "list": {
			const list = node.ordered ? document.createElement("ol") : document.createElement("ul");
			if (node.ordered && list instanceof HTMLOListElement && node.start !== 1) list.start = node.start;
			for (const item of node.items) {
				const entry = document.createElement("li");
				entry.append(inlineFragment(item));
				list.append(entry);
			}
			return list;
		}
		case "code":
			return context.codeBlock(node.text, node.language, codeIndex);
		case "table":
			return tableElement(node);
	}
}

/** A cell whose whole content is one number; a run with markup in it is never a number. */
const numericCell = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;

function numericText(nodes: readonly InlineNode[]): string | undefined {
	if (nodes.length !== 1) return undefined;
	const only = nodes[0];
	if (only === undefined) return undefined;
	return only.kind === "text" || only.kind === "code" ? only.text.trim() : undefined;
}

/**
 * A column's alignment: the delimiter row's, else the right edge when every body cell is a number.
 * Numbers in one column need one right edge with tabular figures, or the digits cannot be compared
 * down the column (LightUI 数位).
 */
function columnAlignment(node: TableNode, column: number): TableAlignment | undefined {
	const declared = node.align[column];
	if (declared !== undefined) return declared;
	if (node.rows.length === 0) return undefined;
	const everyCellIsANumber = node.rows.every((row) => {
		const value = numericText(row[column] ?? []);
		return value !== undefined && numericCell.test(value);
	});
	return everyCellIsANumber ? "right" : undefined;
}

/** A table inside a scroller, so a wide one scrolls instead of pushing the column sideways. */
function tableElement(node: TableNode): HTMLElement {
	const scroll = element("div", "table-scroll");
	const table = document.createElement("table");
	table.className = "markdown-table";
	const head = document.createElement("thead");
	const headRow = document.createElement("tr");
	node.head.forEach((cell, column) => {
		const th = document.createElement("th");
		th.scope = "col";
		const align = columnAlignment(node, column);
		if (align !== undefined) th.className = `align-${align}`;
		th.append(inlineFragment(cell));
		headRow.append(th);
	});
	head.append(headRow);
	table.append(head);
	const body = document.createElement("tbody");
	for (const row of node.rows) {
		const rowElement = document.createElement("tr");
		row.forEach((cell, column) => {
			const td = document.createElement("td");
			const align = columnAlignment(node, column);
			if (align !== undefined) td.className = `align-${align}`;
			td.append(inlineFragment(cell));
			rowElement.append(td);
		});
		body.append(rowElement);
	}
	table.append(body);
	scroll.append(table);
	return scroll;
}

/** An answer as the markdown sheet expects it: one `.markdown` root per assistant block. */
function markdownElement(text: string, context: MarkdownContext): HTMLElement {
	const root = element("div", "markdown");
	let codeIndex = 0;
	for (const node of formatMarkdown(text)) {
		root.append(markdownNode(node, context, node.kind === "code" ? codeIndex++ : 0));
	}
	return root;
}

/** A row's one-line summary: the first non-empty line of a longer text. */
function firstLine(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
	return line?.trim() ?? "";
}

function atBottom(target: HTMLElement): boolean {
	return target.scrollHeight - target.scrollTop - target.clientHeight < 24;
}

/** Whether a number control's value is a whole number inside the range the host accepts. */
function inRange(control: PanelControl, value: string): boolean {
	if (value.trim().length === 0) return false;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || ((control.step ?? 1) >= 1 && !Number.isSafeInteger(parsed))) return false;
	return parsed >= (control.min ?? Number.NEGATIVE_INFINITY) && parsed <= (control.max ?? Number.POSITIVE_INFINITY);
}

/** Arrow keys move within tabs and radio groups; modified arrows belong to the browser. */
function groupKeyTarget(event: KeyboardEvent, current: HTMLButtonElement): HTMLButtonElement | undefined {
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
	const nodes = [...(current.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? [])].filter(node => !node.disabled);
	const offset = event.key === "ArrowLeft" ? -1 : 1;
	const index = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 : (nodes.indexOf(current) + offset + nodes.length) % nodes.length;
	const target = nodes[index];
	if (target) event.preventDefault();
	return target;
}

function fitPrompt(prompt: HTMLTextAreaElement): void {
	prompt.style.height = "auto";
	// The draft grows with its content, up to the cap the stylesheet sets; past it the box scrolls.
	prompt.style.height = `${prompt.scrollHeight}px`;
}

/** The icon each navigation row carries. */
const NAV_ICONS: Record<NavItem["glyph"], IconName> = {
	chat: "home",
	plugins: "package",
	skills: "sparkles",
	automation: "clock",
	settings: "settings",
};

/** The icon each dock tab carries. */
const DOCK_ICONS: Record<DockTabId, IconName> = {
	files: "folder",
	terminal: "terminal",
	conversations: "message",
	tasks: "activity",
	changes: "git-fork",
};

/** Whether this control is the one whose call the page has in flight. */
function isPending(pending: PanelPending | undefined, action: { readonly id: string; readonly data?: string }): boolean {
	return pending !== undefined && pending.id === action.id && (pending.data ?? "") === (action.data ?? "");
}

/** A control whose call is in flight: it reports itself busy and refuses a second activation. */
function markPending(node: HTMLElement, pending: PanelPending | undefined, action: { readonly id: string; readonly data?: string }): void {
	if (!isPending(pending, action)) return;
	node.classList.add("pending");
	node.setAttribute("aria-busy", "true");
	if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement || node instanceof HTMLSelectElement) {
		node.disabled = true;
	}
}

/** A header action is an icon; its words stay on the title and in a screen-reader label. */
function placeHeaderAction(node: HTMLButtonElement, label: string, glyph: IconName): void {
	node.title = label;
	node.setAttribute("aria-label", label);
	node.replaceChildren(icon(glyph), element("span", "sr-only header-action-label", label));
}

function panelButtonClass(action: Pick<PanelButton, "weight" | "danger">): string {
	return `panel-button weight-${action.weight}${action.danger === true ? " is-danger" : ""}`;
}

function panelButton(action: PanelButton, report: (action: PanelAction) => void, pending?: PanelPending): HTMLButtonElement {
	const node = button(`${panelButtonClass(action)}${action.placement === "start" ? " is-footer-start" : ""}`);
	node.dataset.action = action.id;
	if (action.data !== undefined) node.dataset.actionData = action.data;
	node.textContent = action.label;
	node.title = action.label;
	node.disabled = action.disabled === true;
	markPending(node, pending, action);
	node.addEventListener("click", () => report({ kind: "command", id: action.id, data: action.data }));
	return node;
}

/** Product name and version for the window title when no session is attached. */
export interface WindowApp {
	readonly name: string;
	readonly version: string;
}

function writeWindowTitle(app: WindowApp, view: Pick<WebView, "sessionLabel" | "approvalIndicator">): void {
	document.title = windowTitle({
		appName: app.name,
		version: app.version,
		sessionName: view.sessionLabel,
		pendingCount: view.approvalIndicator?.count ?? 0,
	});
}

export function createRenderer(
	elements: PageElements,
	onSelect: (sessionId: string) => void = () => {},
	app?: WindowApp,
): PageRenderer {
	// Before the first paint there is no session. The desktop smoke reads this as soon as the document loads.
	if (app !== undefined) writeWindowTitle(app, { sessionLabel: undefined, approvalIndicator: undefined });
	let lastView: WebView | undefined;
	const dismissedNotices = new Set<string>();
	const noticeTimers = new Map<string, number>();
	const noticeKey = (scope: string, notice: PanelNotice): string => `${scope}\u0000${notice.tone}\u0000${notice.text}`;
	const shownNotices = (scope: string, notices: readonly PanelNotice[]): Array<PanelNotice & { readonly key: string }> => {
		const live = new Set<string>();
		const visible: Array<PanelNotice & { readonly key: string }> = [];
		for (const notice of notices) {
			const key = noticeKey(scope, notice);
			live.add(key);
			if (dismissedNotices.has(key)) continue;
			const persistence = notice.persistence ?? (notice.tone === "info" ? "transient" : "pinned");
			visible.push({ ...notice, text: notice.tone === "error" ? errorMessageCopy(lastView?.locale ?? FALLBACK_LOCALE, notice.text) : notice.text, key });
			if (persistence === "transient" && !noticeTimers.has(key)) {
				noticeTimers.set(key, window.setTimeout(() => {
					noticeTimers.delete(key);
					dismissedNotices.add(key);
					for (const node of document.querySelectorAll<HTMLElement>("[data-notice-key]")) {
						if (node.dataset.noticeKey === key) node.remove();
					}
				}, 2400));
			}
		}
		for (const [key, timer] of noticeTimers) {
			if (!key.startsWith(`${scope}\u0000`) || live.has(key)) continue;
			window.clearTimeout(timer);
			noticeTimers.delete(key);
			dismissedNotices.delete(key);
		}
		return visible;
	};
	const appendNotices = (parent: HTMLElement, notices: readonly (PanelNotice & { readonly key: string })[]): void => {
		for (const notice of notices) {
			const item = element("p", `panel-notice ${notice.tone}`, notice.text);
			item.dataset.noticeKey = notice.key;
			item.setAttribute("role", notice.tone === "error" ? "alert" : "status");
			parent.append(item);
		}
	};
	/** Reader disclosure choices, keyed by block id so a rebuild keeps them. */
	const expanded = new Map<TranscriptBlock["id"], boolean>();
	const flowCache = new DomCache();
	const chromeValues = new Map<string, unknown>();
	const modelSetup = elements.modelSetup ?? modelSetupElement(elements.modelSelect);
	const sharedModelPicker = createModelPicker((provider, modelId) => renderer.onSelectModel(provider, modelId), level => renderer.onSelectThinking(level), () => {
		sections.set(SETTINGS_VIEW, "settings:models");
		report({ kind: "command", id: MODEL_CONNECTIONS_ACTION, data: undefined });
	});
	elements.modelSelect.insertAdjacentElement("beforebegin", sharedModelPicker.element);
	const connections = createModelConnections(action => report(action));
	const transcriptLatest = elements.transcriptLatest ?? transcriptLatestElement(elements.transcript);
	const quoteAction = button("quote-action");
	quoteAction.hidden = true;
	document.body.append(quoteAction);
	const suggestion = pick("composer-suggestion");
	const acceptSuggestion = pickElement("suggestion-accept", HTMLButtonElement);
	const dismissSuggestion = pickElement("suggestion-dismiss", HTMLButtonElement);
	const previewSuggestion = pickElement("suggestion-preview-toggle", HTMLButtonElement);
	const suggestionPreview = pick("suggestion-preview");
	let expandedSuggestionKey: string | undefined;
	let composing = false;
	let dismissedSuggestion: string | undefined;
	let meterExpanded = false;
	const ensureMeterElements = (): {
		readonly trigger: HTMLButtonElement;
		readonly detail: HTMLElement;
		readonly tokensLabel: HTMLElement;
		readonly costLabel: HTMLElement;
	} => {
		const existingTrigger = elements.meter.querySelector<HTMLButtonElement>("#meter-trigger");
		const existingDetail = elements.meter.querySelector<HTMLElement>("#meter-detail");
		const existingTokensLabel = elements.meter.querySelector<HTMLElement>("#meter-tokens-label");
		const existingCostLabel = elements.meter.querySelector<HTMLElement>("#meter-cost-label");
		if (existingTrigger && existingDetail && existingTokensLabel && existingCostLabel) {
			return {
				trigger: existingTrigger,
				detail: existingDetail,
				tokensLabel: existingTokensLabel,
				costLabel: existingCostLabel,
			};
		}
		const trigger = button("meter-trigger");
		trigger.id = "meter-trigger";
		trigger.setAttribute("aria-expanded", "false");
		trigger.setAttribute("aria-controls", "meter-detail");
		trigger.append(elements.meterContext, icon("chevron-down", "icon meter-chevron"));
		const detail = element("div", "meter-detail");
		detail.id = "meter-detail";
		detail.hidden = true;
		const tokensRow = element("div", "meter-detail-row");
		const tokensLabel = element("span", "meter-detail-label");
		tokensLabel.id = "meter-tokens-label";
		tokensRow.append(tokensLabel, elements.meterTokens);
		const costRow = element("div", "meter-detail-row");
		const costLabel = element("span", "meter-detail-label");
		costLabel.id = "meter-cost-label";
		costRow.append(costLabel, elements.meterCost);
		detail.append(tokensRow, costRow);
		elements.meter.replaceChildren(trigger, detail);
		return { trigger, detail, tokensLabel, costLabel };
	};
	const meterNodes = ensureMeterElements();
	const setMeterExpanded = (open: boolean, restoreFocus = false): void => {
		meterExpanded = open;
		meterNodes.trigger.setAttribute("aria-expanded", String(open));
		meterNodes.detail.hidden = !open;
		if (open) elements.meter.dataset.open = "true";
		else delete elements.meter.dataset.open;
		if (!open && restoreFocus) meterNodes.trigger.focus({ preventScroll: true });
	};
	let seenTranscriptDigest = "";
	let unreadTranscriptBelow = false;
	const transcriptDigest = (view: WebView): string =>
		JSON.stringify([
			view.status,
			view.blocks.map((block) => [
				block.id,
				block.text.length,
				block.running,
				block.tone,
				block.result?.status,
				block.result?.duration,
			]),
		]);
	let promptSelection: { start: number; end: number; direction: "forward" | "backward" | "none" } = {
		start: 0,
		end: 0,
		direction: "none",
	};
	let modelSetupReturn: { scope: string; start: number; end: number; direction: "forward" | "backward" | "none" } | undefined;
	const rememberPromptSelection = (): void => {
		promptSelection = {
			start: elements.prompt.selectionStart,
			end: elements.prompt.selectionEnd,
			direction: elements.prompt.selectionDirection,
		};
	};
	const triggerModelSetup = (actionId: string): void => {
		if (lastView !== undefined) {
			modelSetupReturn = {
				scope: attachmentScope(lastView),
				...promptSelection,
			};
		}
		report({ kind: "command", id: actionId, data: undefined });
	};
	const changed = (key: string, value: unknown): boolean => {
		if (chromeValues.has(key) && sameViewValue(chromeValues.get(key), value)) return false;
		chromeValues.set(key, value);
		return true;
	};
	/** Text a reader is typing into a panel control, keyed by action id and target. */
	const drafts = new Map<string, string>();
	/** In-flight and recently settled control saves, keyed by control identity. */
	const controlCommits = new Map<string, { value: string; status: "saving" | "saved"; timer?: number }>();
	const TYPOGRAPHY_ROW_IDS = new Set([
		"setting:textFont",
		"setting:codeFont",
		"setting:terminalFont",
		"setting:textSize",
		"setting:codeSize",
		"setting:terminalSize",
	]);
	const FONT_FAMILY_SET = new Set<string>(FONT_FAMILY_FIELDS);
	const normalizeControlValue = (control: PanelControl, value: string): string => {
		if (control.kind === "number") {
			if (value.trim() === "") return value;
			const parsed = Number(value);
			return Number.isFinite(parsed) ? String(parsed) : value;
		}
		if (control.id === SETTINGS_FIELD_ACTION && control.data !== undefined && FONT_FAMILY_SET.has(control.data)) {
			try {
				return normalizeFontFamily(value);
			} catch {
				return value;
			}
		}
		return value;
	};
	const sameControlValue = (control: PanelControl, left: string, right: string): boolean =>
		normalizeControlValue(control, left) === normalizeControlValue(control, right);
	/** Unsubmitted panel inputs belong to a session, unlike global settings drafts. */
	const inputDrafts = new Map<string, string>();
	/** The modal already in the DOM; a rebuild would drop what the reader typed into it. */
	let modalKey: string | undefined;
	/** The open modal's submit and message line, so a state flip updates them without a rebuild. */
	let modalSubmit: HTMLButtonElement | undefined;
	let modalMessage: HTMLParagraphElement | undefined;
	/** Native dialogs isolate the page; the logical trigger also survives replicated DOM replacements. */
	let modalReturnFocus: { node: HTMLElement; selector?: string } | undefined;
	const captureModalFocus = (): void => {
		if (modelSetupReturn !== undefined && lastView?.panel.current === CHAT_VIEW) {
			modalReturnFocus = { node: elements.prompt, selector: "#prompt" };
			return;
		}
		const node = document.activeElement;
		if (!(node instanceof HTMLElement) || elements.modalRoot.contains(node)) return;
		const selector = node.id ? `#${CSS.escape(node.id)}`
			: node.dataset.controlKey ? `[data-control-key="${CSS.escape(node.dataset.controlKey)}"]`
			: node.dataset.menuId ? `[data-menu-id="${CSS.escape(node.dataset.menuId)}"]`
			: node.classList.contains("session-more") && node.dataset.actionData ? `.session-more[data-action-data="${CSS.escape(node.dataset.actionData)}"]`
			: node.dataset.action ? `[data-action="${CSS.escape(node.dataset.action)}"]${node.dataset.actionData === undefined ? "" : `[data-action-data="${CSS.escape(node.dataset.actionData)}"]`}` : undefined;
		modalReturnFocus = { node, selector };
	};
	const requestModalClose = (): void => {
		if (lastView?.panel.modal?.pending !== true) report({ kind: "modal-close" });
	};
	let rosterKey = "";
	let sessionMenu: { id: string; node: HTMLElement } | undefined;
	let heldPromptFocus: { start: number; end: number; direction: "forward" | "backward" | "none" } | undefined;
	let connectionCopy: { text: ConnectionText; kind: "state" | "error"; label?: ConnectionText } | undefined;
	let connectionStateCopy: { text: ConnectionText; state: ConnectionState } = {
		text: (locale) => translate(locale, "connection.starting"),
		state: "connecting",
	};
	/** Presentation-only category selection; changing pages never detaches the current session. */
	const sections = new Map<string, string>();
	/** The settings query, the highlighted result, and the row a result asked to reveal. */
	let settingsQuery = "";
	let settingsHighlight = -1;
	let settingsHighlightFollow = false;
	let settingsHits: SettingsSearchHit[] = [];
	let locatedRow: { groupId: string; rowId: string } | undefined;
	let locatedScrolled = false;
	/** The conversation sidebar's collapsed state, restored when the reader leaves settings. */
	const libraryNav = document.getElementById("library-nav");
	let restoreChatPosition: (() => void) | undefined;
	let shownSection = "";

	const draft = (): string => elements.prompt.value.trim();

	/** The language of the view being painted; the fallback only applies before the first paint. */
	const copy = (key: MessageKey, values?: Record<string, string>): string => translate(lastView?.locale ?? FALLBACK_LOCALE, key, values);
	let quoteDraft: string | undefined;
	let quoteTimer: number | undefined;
	const hideQuoteAction = (): void => {
		quoteDraft = undefined;
		quoteAction.hidden = true;
	};
	const updateQuoteAction = (): void => {
		const view = lastView;
		if (
			view === undefined ||
			view.panel.current !== CHAT_VIEW ||
			view.readOnly === true ||
			view.attachedId === undefined ||
			elements.transcript.hidden ||
			elements.prompt.disabled ||
			elements.modalRoot.open
		) {
			hideQuoteAction();
			return;
		}
		const selection = document.getSelection();
		if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
			hideQuoteAction();
			return;
		}
		const range = selection.getRangeAt(0);
		const node = range.commonAncestorContainer;
		const element = node instanceof Element ? node : node.parentElement;
		const answer = element?.closest<HTMLElement>(".turn-response") ?? undefined;
		if (answer === undefined || !elements.transcript.contains(answer)) {
			hideQuoteAction();
			return;
		}
		const selected = quotedDraft(selection.toString());
		if (selected === undefined) {
			hideQuoteAction();
			return;
		}
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			hideQuoteAction();
			return;
		}
		quoteDraft = selected;
		quoteAction.textContent = copy("composer.quote");
		quoteAction.setAttribute("aria-label", copy("composer.quote"));
		quoteAction.title = copy("composer.quote");
		quoteAction.hidden = false;
		const width = quoteAction.offsetWidth;
		const height = quoteAction.offsetHeight;
		const left = Math.min(
			window.innerWidth - width - 8,
			Math.max(8, rect.left + rect.width / 2 - width / 2),
		);
		const below = rect.bottom + 8;
		const top = below + height <= window.innerHeight - 8
			? below
			: Math.max(8, rect.top - height - 8);
		quoteAction.style.left = `${left}px`;
		quoteAction.style.top = `${top}px`;
	};
	const scheduleQuoteAction = (): void => {
		if (quoteTimer !== undefined) window.clearTimeout(quoteTimer);
		quoteTimer = window.setTimeout(updateQuoteAction, 40);
	};
	const renderConnection = (): void => {
		const locale = lastView?.locale ?? FALLBACK_LOCALE;
		const resolve = (value: ConnectionText): string => typeof value === "string" ? value : value(locale);
		elements.connectionStatus.dataset.state = connectionStateCopy.state;
		const status = resolve(connectionStateCopy.text);
		// Retain the logo and dot; only changed copy should announce a live-region update.
		if (elements.connectionStatusText.textContent !== status) elements.connectionStatusText.textContent = status;
		elements.connection.hidden = connectionCopy === undefined;
		if (connectionCopy === undefined) {
			elements.connection.textContent = "";
			elements.connection.removeAttribute("title");
			elements.connection.removeAttribute("aria-label");
			return;
		}
		const raw = resolve(connectionCopy.text);
		const text = connectionCopy.kind === "error" ? errorMessageCopy(locale, raw) : raw;
		elements.connection.className = `connection ${connectionCopy.kind}`;
		elements.connection.title = text;
		elements.connection.setAttribute("aria-label", text);
		const label = connectionCopy.label === undefined ? text : resolve(connectionCopy.label);
		if (elements.connection.textContent !== label) elements.connection.textContent = label;
	};
	/** The document is localized at startup; its retained controls follow later language changes. */
	const renderShellCopy = (): void => {
		for (const [node, key] of [
			[elements.nav, "sidebar.management"],
			[elements.rosterFilter, "sidebar.filter"],
			[elements.rosterFilterToggle, "sidebar.filter"],
			[elements.sidebarToggle, "sidebar.toggle"],
			[elements.viewBack, "header.back"],
			[elements.attach, "composer.attach"],
			[elements.primary, "composer.send"],
			[elements.stop, "composer.stop"],
			[elements.modelSelect, "model.heading"],
			[elements.thinkingSelect, "model.effort"],
		] as const) node.setAttribute("aria-label", copy(key));
		elements.nav.parentElement?.setAttribute("aria-label", copy("sidebar.management"));
		for (const [node, key] of [
			[elements.sidebarToggle, "sidebar.toggle"],
			[elements.rosterFilterToggle, "sidebar.filter"],
			[elements.attach, "composer.attach"],
		] as const) node.title = copy(key);
		elements.rosterFilter.placeholder = copy("sidebar.filter");
		elements.sectionSearchInput.placeholder = copy("panel.settings.search");
		elements.sectionSearchInput.setAttribute("aria-label", copy("panel.settings.searchLabel"));
		elements.sectionSearchClear.setAttribute("aria-label", copy("panel.settings.searchClear"));
		const sessions = elements.sidebar.querySelector(".sidebar-label");
		if (sessions !== null) sessions.textContent = copy("sidebar.sessions");
		renderConnection();
	};

	const report = (action: PanelAction): void => {
		// Adding a provider always opens that settings section, including from a modal or a stale category.
		if (action.kind === "command" && action.id === MODEL_CONNECTIONS_ACTION) sections.set(SETTINGS_VIEW, "settings:models");
		renderer.onPanelAction(action);
	};

	const controlKey = (control: PanelControl): string => `${control.id}\u0000${control.data ?? ""}`;

	const resolveControlStatus = (control: PanelControl, pending: PanelPending | undefined): "saving" | "saved" | undefined => {
		const key = controlKey(control);
		const current = controlCommits.get(key);
		const hasErrorNotice = lastView?.panel.panel?.notices.some((notice) => notice.tone === "error") === true;
		if (isPending(pending, control)) return "saving";
		if (current === undefined) return undefined;
		if (hasErrorNotice) {
			if (current.timer !== undefined) window.clearTimeout(current.timer);
			controlCommits.delete(key);
			return undefined;
		}
		const matches = sameControlValue(control, current.value, control.value);
		if (!matches) {
			if (current.timer !== undefined) window.clearTimeout(current.timer);
			controlCommits.delete(key);
			return undefined;
		}
		if (current.status === "saving") {
			const timer = window.setTimeout(() => {
				if (controlCommits.get(key)?.timer !== timer) return;
				controlCommits.delete(key);
				for (const statusNode of elements.viewBody.querySelectorAll<HTMLElement>("[data-control-status]")) {
					if (statusNode.dataset.controlStatus !== key) continue;
					if (statusNode.dataset.defaultHint) {
						statusNode.textContent = statusNode.dataset.defaultHint;
						statusNode.dataset.state = "hint";
						statusNode.hidden = false;
					} else {
						statusNode.textContent = "";
						statusNode.hidden = true;
						delete statusNode.dataset.state;
					}
				}
			}, 2400);
			controlCommits.set(key, { value: control.value, status: "saved", timer });
		}
		return "saved";
	};

	const applyGroupTypographyPreview = (preview: HTMLElement, groupNode?: Element | null): void => {
		const base: Record<string, unknown> = { ...(lastView?.typography ?? DEFAULT_TYPOGRAPHY) };
		for (const field of ["textFont", "codeFont", "terminalFont", "textSize", "codeSize", "terminalSize"] as const) {
			const key = `${SETTINGS_FIELD_ACTION}\u0000${field}`;
			const inputNode = groupNode
				? [...groupNode.querySelectorAll<HTMLInputElement>("input[data-control-key]")].find(
						(node) => node.dataset.controlKey === key,
				  )
				: undefined;
			const raw = inputNode?.value ?? drafts.get(key);
			if (raw === undefined) continue;
			base[field] = field.endsWith("Size") ? (raw.trim() === "" ? Number.NaN : Number(raw)) : raw;
		}
		applyTypography(preview.style, resolveTypography(base));
	};

	/** One control: a switch applies at once, a select at once, text and numbers on commit. */
	const controlElement = (control: PanelControl, pending: PanelPending | undefined, rowTitle: string): HTMLElement => {
		const key = controlKey(control);
		const name = control.label === undefined ? rowTitle : `${rowTitle} · ${control.label}`;
		const emit = (value: string): void => {
			const previousCommit = controlCommits.get(key);
			if (previousCommit?.timer !== undefined) window.clearTimeout(previousCommit.timer);
			controlCommits.set(key, { value, status: "saving" });
			if (control.kind === "text" || control.kind === "number") drafts.set(key, value);
			else drafts.delete(key);
			report({ kind: "control", id: control.id, data: control.data, value });
		};
		if (control.kind === "switch") {
			const label = element("label", "panel-switch");
			const input = document.createElement("input");
			input.type = "checkbox";
			input.dataset.controlKey = key;
			input.setAttribute("aria-label", name);
			input.checked = control.value === "true";
			input.disabled = control.disabled === true;
			input.addEventListener("change", () => emit(String(input.checked)));
			label.append(input, element("span", "panel-switch-track"));
			if (isPending(pending, control)) {
				// The track is what the reader sees; the checkbox is what takes the click, so both
				// carry the state and the control itself refuses a second activation.
				label.classList.add("pending");
				label.setAttribute("aria-busy", "true");
				input.disabled = true;
			}
			return label;
		}
		if (control.kind === "select") {
			const select = document.createElement("select");
			select.className = "panel-select";
			select.dataset.controlKey = key;
			select.setAttribute("aria-label", name);
			const groups = new Map<string, HTMLOptGroupElement>();
			for (const option of control.options ?? []) {
				const node = document.createElement("option");
				node.value = option.value;
				node.textContent = option.label;
				node.selected = option.value === control.value;
				node.disabled = option.disabled === true;
				if (option.group === undefined) select.append(node);
				else {
					let group = groups.get(option.group);
					if (!group) {
						group = document.createElement("optgroup");
						group.label = option.group;
						groups.set(option.group, group);
						select.append(group);
					}
					group.append(node);
				}
			}
			select.disabled = control.disabled === true;
			select.addEventListener("change", () => emit(select.value));
			markPending(select, pending, control);
			return select;
		}
		const input = document.createElement("input");
		input.dataset.controlKey = key;
		input.setAttribute("aria-label", name);
		input.className = control.kind === "number" ? "panel-input panel-number" : "panel-input";
		input.type = control.kind === "number" ? "number" : "text";
		const saved = drafts.get(key);
		if (saved !== undefined && sameControlValue(control, saved, control.value)) drafts.delete(key);
		input.value = drafts.get(key) ?? control.value;
		if (control.placeholder !== undefined) input.placeholder = control.placeholder;
		if (control.min !== undefined) input.min = String(control.min);
		if (control.max !== undefined) input.max = String(control.max);
		if (control.step !== undefined) input.step = String(control.step);
		input.disabled = control.disabled === true;
		markPending(input, pending, control);
		const field = element("div", "panel-field");
		const error = element("p", "panel-field-error");
		error.id = `field-error-${encodeURIComponent(key)}`;
		error.setAttribute("role", "alert");
		error.hidden = true;
		const status = element("p", "panel-field-status");
		const defaultHint = copy("panel.settings.commitHint");
		status.dataset.controlStatus = key;
		status.dataset.defaultHint = defaultHint;
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		const syncFieldStatus = (override?: "saving" | "saved"): void => {
			if (!error.hidden) {
				status.hidden = true;
				return;
			}
			status.hidden = false;
			const state = override ?? resolveControlStatus(control, pending);
			if (state === "saving") {
				status.textContent = copy("panel.settings.saving");
				status.dataset.state = "saving";
			} else if (state === "saved" && sameControlValue(control, input.value, control.value)) {
				status.textContent = copy("panel.settings.saved");
				status.dataset.state = "saved";
			} else {
				status.textContent = defaultHint;
				status.dataset.state = !sameControlValue(control, input.value, control.value) ? "dirty" : "hint";
			}
		};
		const validate = (): boolean => {
			const invalid = control.kind === "number" && !inRange(control, input.value);
			error.hidden = !invalid;
			input.classList.toggle("invalid", invalid);
			if (invalid) {
				error.textContent = copy(control.max !== undefined ? "panel.settings.invalidRange" : (control.step ?? 1) < 1 ? "panel.settings.invalidDecimal" : "panel.settings.invalidNumber", { min: String(control.min ?? 0), max: String(control.max ?? "") });
				input.setAttribute("aria-invalid", "true");
				input.setAttribute("aria-describedby", error.id);
			} else {
				input.removeAttribute("aria-invalid");
				input.removeAttribute("aria-describedby");
			}
			syncFieldStatus();
			return !invalid;
		};
		if (drafts.has(key)) validate();
		else syncFieldStatus();
		input.addEventListener("input", () => {
			const previous = controlCommits.get(key);
			if (previous?.status === "saved") {
				if (previous.timer !== undefined) window.clearTimeout(previous.timer);
				controlCommits.delete(key);
			}
			drafts.set(key, input.value);
			if (!error.hidden) validate();
			else syncFieldStatus();
			const groupNode = field.closest(".panel-group");
			const preview = groupNode?.querySelector<HTMLElement>("[data-typography-preview]");
			if (preview) applyGroupTypographyPreview(preview, groupNode);
		});
		const commit = (): void => {
			// A number outside the host's range is answered here, in the reader's language, and
			// keeps the draft so the reader can correct it instead of losing what they typed.
			if (!validate()) return;
			const normalized = normalizeControlValue(control, input.value);
			const currentCommit = controlCommits.get(key);
			const currentTarget = currentCommit?.status === "saving" ? currentCommit.value : control.value;
			if (sameControlValue(control, input.value, currentTarget)) {
				if (input.value !== normalized) input.value = normalized;
				if (sameControlValue(control, normalized, control.value)) drafts.delete(key);
				syncFieldStatus();
				return;
			}
			if (input.value !== normalized) input.value = normalized;
			syncFieldStatus("saving");
			emit(normalized);
		};
		input.addEventListener("change", commit);
		input.addEventListener("keydown", event => {
			if (event.key !== "Enter" || event.isComposing) return;
			event.preventDefault();
			commit();
		});
		field.append(input, error, status);
		return field;
	};

	/** Absolute paths read as one line under the description. A status sentence stays in the trailing column. */
	const recordPath = (value: string | undefined): value is string =>
		value !== undefined && !value.includes(" · ")
		&& (value.startsWith("/") || value.startsWith("\\") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value));

	const rowElementOf = (row: PanelRow, pending?: PanelPending, skeleton?: PanelSkeleton): HTMLElement => {
		if (row.file) {
			const node = panelButton(row.file.action, report, pending);
			node.className = `file-entry file-entry-${row.file.kind}`;
			node.dataset.rowId = row.id;
			node.dataset.fileName = row.title;
			node.dataset.controlKey = `file:${row.file.action.data ?? row.id}`;
			node.title = row.file.action.data ?? row.title;
			node.setAttribute("aria-label", `${row.file.action.label}: ${row.title}`);
			node.replaceChildren(icon(row.file.kind === "up" ? "arrow-up" : row.file.kind === "dir" ? "folder" : "file"), element("span", "file-entry-name", row.title));
			if (row.value) node.append(element("span", "file-entry-size", row.value));
			if (row.file.kind === "dir") node.append(icon("chevron-down", "icon file-entry-chevron"));
			return node;
		}
		const records = skeleton === "records";
		const node = element("div", records ? "panel-row record-row" : "panel-row");
		node.dataset.rowId = row.id;
		const text = element("div", "panel-row-text");
		const head = element("div", "panel-row-head");
		head.append(element("span", "panel-row-title", row.title));
		if (!records) for (const badge of row.badges ?? []) head.append(element("span", "panel-badge", badge));
		text.append(head);
		if (row.description !== undefined) text.append(element("p", "panel-row-desc", row.description));
		const path = records && recordPath(row.value) ? row.value : undefined;
		if (path !== undefined) text.append(element("code", "record-path", path));
		else if (!records && row.value !== undefined) text.append(element("code", "panel-row-value", row.value));
		node.append(text);
		if (records && ((row.badges?.length ?? 0) > 0 || (row.value !== undefined && path === undefined))) {
			const status = element("div", "record-status");
			for (const badge of row.badges ?? []) status.append(element("span", "panel-badge", badge));
			if (row.value !== undefined && path === undefined) status.append(element("span", "record-value", row.value));
			node.append(status);
		}
		if (row.controls !== undefined && row.controls.length > 0) {
			const controls = element("div", "panel-controls");
			for (const control of row.controls) {
				controls.append(controlElement(control, pending, row.title));
				if (control.kind === "switch" || control.kind === "select") {
					const key = controlKey(control);
					const state = resolveControlStatus(control, pending);
					const badge = element("span", "panel-control-status");
					badge.dataset.controlStatus = key;
					badge.setAttribute("role", "status");
					badge.setAttribute("aria-live", "polite");
					if (state === undefined) {
						badge.hidden = true;
					} else {
						badge.hidden = false;
						badge.dataset.state = state;
						badge.textContent = copy(state === "saving" ? "panel.settings.saving" : "panel.settings.saved");
					}
					controls.append(badge);
				}
			}
			node.append(controls);
		}
		if ((row.actions?.length ?? 0) > 0 || row.menu !== undefined) {
			const actions = element("div", "panel-actions");
			for (const action of row.actions ?? []) actions.append(panelButton(action, report, pending));
			if (row.menu !== undefined) {
				const menu = row.menu;
				const choices = menu.actions.map(action => ({ ...action, danger: action.danger === true, disabled: action.disabled || isPending(pending, action) }));
				const id = `panel:${row.id}:${JSON.stringify(choices.map(action => [action.id, action.disabled === true]))}`;
				const more = button("panel-button weight-text panel-more");
				more.dataset.menuId = id;
				more.dataset.action = "panel:more";
				more.dataset.actionData = menu.data;
				more.title = menu.label;
				more.setAttribute("aria-label", `${menu.label}: ${row.title.trim()}`);
				more.setAttribute("aria-haspopup", "menu");
				more.setAttribute("aria-expanded", String(sessionMenu?.id === id));
				more.disabled = choices.every(action => action.disabled);
				more.append(icon("more"));
				more.addEventListener("click", () => openRosterMenu(id, menu.data, menu.label, choices));
				actions.append(more);
			}
			node.append(actions);
		}
		return node;
	};

	const groupElement = (group: PanelGroup, pending?: PanelPending): HTMLElement => {
		const node = element("section", "panel-group");
		node.dataset.groupId = group.id;
		if (group.skeleton !== undefined) node.dataset.skeleton = group.skeleton;
		const head = element("header", "panel-group-head");
		const titles = element("div", "panel-group-titles");
		if (group.title) titles.append(element("h2", "panel-group-title", group.title));
		if (group.description !== undefined) titles.append(element("p", "panel-group-desc", group.description));
		if (titles.childElementCount > 0) head.append(titles);
		if (group.actions !== undefined && group.actions.length > 0) {
			const actions = element("div", "panel-actions");
			for (const action of group.actions) actions.append(panelButton(action, report, pending));
			head.append(actions);
		}
		if (head.childElementCount > 0) node.append(head);
		if (group.lead !== undefined) {
			const lead = element("div", "panel-lead");
			lead.append(element("p", "panel-lead-title", group.lead.title));
			if (group.lead.description !== undefined) lead.append(element("p", "panel-lead-desc", group.lead.description));
			const actions = element("div", "panel-actions");
			for (const action of group.lead.actions) actions.append(panelButton(action, report, pending));
			lead.append(actions);
			node.append(lead);
		}
		const rows = element("div", "panel-rows");
		if (group.id === "files:entries" || group.rows.some(row => row.file)) {
			rows.classList.add("file-entries");
			rows.addEventListener("keydown", event => {
				if (event.isComposing || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				const controls = [...rows.querySelectorAll<HTMLButtonElement>(".file-entry:not(:disabled):not([hidden])")];
				const index = controls.indexOf(document.activeElement as HTMLButtonElement);
				if (index < 0) return;
				event.preventDefault();
				const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : Math.max(0, Math.min(controls.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
				controls[next]?.focus();
			});
		}
		if (group.rows.length === 0 && group.empty !== undefined) {
			const empty = element("p", "panel-empty", group.empty.text);
			empty.dataset.cause = group.empty.cause;
			rows.append(empty);
		} else for (const row of group.rows) rows.append(rowElementOf(row, pending, group.skeleton));
		node.append(rows);
		if (group.rows.some((row) => TYPOGRAPHY_ROW_IDS.has(row.id))) {
			const preview = element("div", "typography-preview");
			preview.dataset.typographyPreview = "true";
			preview.setAttribute("role", "region");
			preview.setAttribute("aria-label", copy("panel.settings.fontPreviewTitle"));
			const title = element("p", "typography-preview-title", copy("panel.settings.fontPreviewTitle"));
			const textSample = element("p", "typography-preview-item preview-text", copy("panel.settings.fontPreviewText"));
			const codeSample = element("pre", "typography-preview-item preview-code");
			codeSample.append(element("code", "", copy("panel.settings.fontPreviewCode")));
			const terminalSample = element("pre", "typography-preview-item preview-terminal");
			terminalSample.append(element("code", "", copy("panel.settings.fontPreviewTerminal")));
			preview.append(title, textSample, codeSample, terminalSample);
			applyGroupTypographyPreview(preview, rows);
			node.append(preview);
		}
		if (group.footnote !== undefined) node.append(element("p", "panel-footnote", group.footnote));
		return node;
	};

	/**
	 * One input line: the reader types, the submit control runs it. A repaint reuses the same row
	 * for the same input, so a command being typed (or a focused field) survives the dock's output
	 * landing underneath it.
	 */
	const inputElement = (input: PanelInput, existing?: HTMLElement): HTMLElement => {
		const scope = lastView?.attachedId ?? "";
		if (existing !== undefined && existing.dataset.inputRow === input.id && existing.dataset.inputScope === scope) {
			const field = existing.querySelector("input");
			if (field !== null) { field.placeholder = input.placeholder; field.setAttribute("aria-label", input.placeholder); }
			const submit = existing.querySelector("button");
			if (submit !== null) {
				submit.disabled = input.submit.disabled === true;
				submit.textContent = input.submit.label;
			}
			return existing;
		}
		const form = element("form", "panel-input-row");
		form.dataset.inputRow = input.id;
		form.dataset.inputScope = scope;
		const field = document.createElement("input");
		field.type = "text";
		field.className = "panel-input panel-input-wide";
		field.placeholder = input.placeholder;
		field.setAttribute("aria-label", input.placeholder);
		const key = `input:${scope}:${input.id}`;
		field.value = inputDrafts.get(key) ?? input.value;
		field.dataset.controlKey = key;
		field.addEventListener("input", () => inputDrafts.set(key, field.value));
		field.autocomplete = "off";
		field.spellcheck = false;
		// The submit control carries what the reader typed, which is why it does not go through
		// the shared button helper: that one reports a fixed action id and subject.
		const submit = button(panelButtonClass(input.submit));
		submit.dataset.action = input.submit.id;
		submit.textContent = input.submit.label;
		submit.disabled = input.submit.disabled === true;
		const run = (): void => {
			if (!submit.disabled) report({ kind: "command", id: input.submit.id, data: field.value });
		};
		submit.addEventListener("click", run);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			run();
		});
		form.append(field, submit);
		return form;
	};

	const reading = createReadingControls({ copy, copyText: (control, text, label) => copyAnswer(control, text, label),
		preservePosition: root => {
			if (elements.column.contains(root)) return transcriptPosition(elements.column, elements.transcript, false);
			for (let parent = root.parentElement; parent; parent = parent.parentElement) {
				if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return transcriptPosition(parent, parent, false);
			}
			return () => {};
		},
	});
	const fileBrowser = createFileBrowser({ icon, copy, actionButton: (action, pending) => panelButton(action, report, pending),
		headerAction: placeHeaderAction, copyText: (control, text, label) => copyAnswer(control, text, label), reading,
	});
	const textElement = fileBrowser.text;

	const panelElement = (panel: PanelSpec, container?: HTMLElement): HTMLElement => {
		const node = element("div", "panel");
		node.dataset.panelId = panel.id;
		const head = element("header", "panel-head");
		if (panel.title.length > 0 || panel.description) {
			const titles = element("div", "panel-titles");
			if (panel.title.length > 0) titles.append(element("h1", "panel-title", panel.title));
			if (panel.description) titles.append(element("p", "panel-desc", panel.description));
			head.append(titles);
		}
		if (panel.actions?.length) {
			const actions = element("div", "panel-actions");
			for (const action of panel.actions) actions.append(panelButton(action, report, panel.pending));
			head.append(actions);
		}
		if (head.childElementCount > 0) node.append(head);
		appendNotices(node, shownNotices(panel.id, panel.notices));
		const previousInput = container?.querySelector<HTMLElement>("form[data-input-row]") ?? undefined;
		for (const input of panel.inputs ?? []) node.append(inputElement(input, previousInput));
		for (const group of panel.groups) node.append(groupElement(group, panel.pending));
		for (const text of panel.texts ?? []) node.append(text.diff
			? diffElement({ text: text.text, label: text.title ?? copy("review.diff") }, `panel:${panel.id}:${text.id}`)
			: textElement(text));
		if (panel.files) {
			const navigation = fileBrowser.navigation(panel, node, lastView?.attachedId ?? "");
			if (head.isConnected) head.after(navigation);
			else node.prepend(navigation);
		}
		return node;
	};

	/** Replicated settings may repaint during typing; keep focus and the text selection on that field. */
	const panelFocus = new WeakMap<HTMLElement, { scope: string; key: string; start: number | null; end: number | null }>();
	const replacePanel = (container: HTMLElement, panel: PanelSpec): void => {
		const scope = `${lastView?.attachedId ?? ""}:${panel.id}:${panel.groups.map(group => group.id).join(",")}`;
		const active = document.activeElement;
		if (active instanceof HTMLElement && container.contains(active) && active.dataset.controlKey) {
			panelFocus.set(container, { scope: container.dataset.panelScope ?? scope, key: active.dataset.controlKey,
				start: active instanceof HTMLInputElement ? active.selectionStart : null,
				end: active instanceof HTMLInputElement ? active.selectionEnd : null });
		} else if (active !== document.body) panelFocus.delete(container);
		const focus = panelFocus.get(container);
		container.replaceChildren(panelElement(panel, container));
		container.dataset.panelScope = scope;
		if (!focus || focus.scope !== scope) { panelFocus.delete(container); return; }
		const target = [...container.querySelectorAll<HTMLElement>("[data-control-key]")].find(node => node.dataset.controlKey === focus.key);
		if (!target) { panelFocus.delete(container); return; }
		if (target.matches(":disabled")) return;
		target.focus({ preventScroll: true });
		if (target instanceof HTMLInputElement && focus.start !== null && focus.end !== null) target.setSelectionRange(focus.start, focus.end);
		panelFocus.delete(container);
	};

	/**
	 * The modal's fields are read on submit, and the modal is only rebuilt when its identity or
	 * default values change, so a rebuild elsewhere in the view never drops a half-typed field.
	 */

	/**
	 * The modal's in-flight and message state, applied on every render: a rebuild would drop what the
	 * reader typed, so the submit and the message line are updated in place instead.
	 */
	const applyModalState = (modal: PanelModal): void => {
		// A fieldset also disables controls added by a directory response that arrives during submit.
		elements.modalRoot.querySelector<HTMLFieldSetElement>(".modal-body")!.disabled = modal.pending === true;
		for (const control of elements.modalRoot.querySelectorAll<HTMLButtonElement>(".modal-head button, .modal-foot button")) {
			if (modal.pending === true) {
				control.dataset.pendingDisabled ??= String(control.disabled);
				control.disabled = true;
			} else if (control.dataset.pendingDisabled !== undefined) {
				control.disabled = control.dataset.pendingDisabled === "true";
				delete control.dataset.pendingDisabled;
			}
		}
		const wasPending = elements.modalRoot.getAttribute("aria-busy") === "true";
		elements.modalRoot.setAttribute("aria-busy", String(modal.pending === true));
		if (modalSubmit !== undefined) {
			modalSubmit.classList.toggle("pending", modal.pending === true);
			if (wasPending && !modalSubmit.disabled && document.activeElement === elements.modalRoot.querySelector(".modal-card")) modalSubmit.focus();
		}
		// A disabled field cannot own keyboard focus while its call is running.
		if (modal.pending === true) elements.modalRoot.querySelector<HTMLElement>(".modal-card")?.focus({ preventScroll: true });
		if (modalMessage !== undefined) {
			const notice = modal.notice;
			const text = notice === undefined ? "" : notice.tone === "error" ? errorMessageCopy(lastView?.locale ?? FALLBACK_LOCALE, notice.text) : notice.text;
			modalMessage.setAttribute("role", notice?.tone === "error" ? "alert" : "status");
			if (modalMessage.textContent !== text) modalMessage.textContent = text;
			modalMessage.className = notice === undefined ? "modal-notice"
				: notice.verification !== undefined ? `modal-notice connection-verification ${notice.verification}`
				: `modal-notice ${notice.tone}`;
			modalMessage.hidden = notice === undefined;
		}
	};

	const renderModal = (modal: PanelModal | undefined): void => {
		const key =
			modal === undefined ? undefined : JSON.stringify([modal.id, modal.data, modal.title, modal.description, modal.fields, modal.submit, modal.dismiss, modal.actions, modal.danger, modal.presentation]);
		if (key === modalKey) {
			if (modal !== undefined) applyModalState(modal);
			return;
		}
		modalKey = key;
		if (modal === undefined) {
			modalSubmit = undefined;
			modalMessage = undefined;
			elements.modalRoot.close();
			elements.modalRoot.classList.remove("is-drawer");
			elements.modalRoot.replaceChildren();
			elements.modalRoot.hidden = true;
			elements.modalRoot.removeAttribute("aria-busy");
			const saved = modalReturnFocus;
			modalReturnFocus = undefined;
			const target = saved?.node.isConnected ? saved.node : saved?.selector ? document.querySelector<HTMLElement>(saved.selector) : undefined;
			if (target && target !== document.body && !target.closest("[hidden], [inert]") && !target.matches(":disabled")) target.focus({ preventScroll: true });
			else if (!elements.prompt.disabled && !elements.composerDock.hidden) elements.prompt.focus({ preventScroll: true });
			else if (!elements.settingsButton.hidden) elements.settingsButton.focus({ preventScroll: true });
			else elements.sidebarToggle.focus({ preventScroll: true });
			return;
		}
		elements.modalRoot.classList.toggle("is-drawer", modal.presentation === "drawer");
		const card = element("div", "modal-card");
		card.tabIndex = -1;
		const projectForm = modal.fields.some(field => field.kind === "directories");
		if (projectForm) card.classList.add("modal-project");
		elements.modalRoot.setAttribute("aria-labelledby", "modal-title");
		if (modal.description !== undefined) elements.modalRoot.setAttribute("aria-describedby", "modal-description");
		else elements.modalRoot.removeAttribute("aria-describedby");
		const head = element("header", "modal-head");
		const titles = element("div", "modal-titles");
		const title = element("h2", "modal-title", modal.title);
		title.id = "modal-title";
		titles.append(title);
		if (modal.description !== undefined) {
			const description = element("p", "modal-desc", modal.description);
			description.id = "modal-description";
			titles.append(description);
		}
		const close = button("modal-close");
		close.setAttribute("aria-label", copy("panel.dismiss"));
		close.append(icon("x"));
		close.addEventListener("click", requestModalClose);
		head.append(titles, close);
		const body = element("fieldset", "modal-body");
		const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
		const fieldContainers = new Map<string, HTMLElement>();
		const fieldFocuses: HTMLElement[] = [];
		for (const field of modal.fields) {
			const label = element(field.kind === "multiselect" || field.kind === "directories" ? "div" : "label", "modal-field");
			label.append(element("span", "modal-field-label", field.label));
			fieldContainers.set(field.id, label);
			if (field.kind === "directories") {
				const control = createDirectoryField(field, lastView?.locale ?? FALLBACK_LOCALE, {
					browse: path => renderer.onBrowseDirectories?.(path) ?? Promise.reject(new Error("Folder selection is unavailable")),
					pick: () => renderer.onPickDirectories?.() ?? Promise.resolve(undefined),
					folderIcon: () => icon("folder"),
				});
				label.append(control.body); inputs.set(field.id, control.value); fieldFocuses.push(control.focus);
				body.append(label); continue;
			}
			if (projectForm && field.id === "name") { label.classList.add("project-name-field"); label.append(icon("folder")); }
			if (field.kind === "multiselect") {
				const control = createMultiselect(field, lastView?.locale ?? FALLBACK_LOCALE);
				label.append(control.body); inputs.set(field.id, control.value);
				fieldFocuses.push(control.focus);
				body.append(label); continue;
			}
			const input = field.kind === "textarea" ? document.createElement("textarea") : field.kind === "select" ? document.createElement("select") : document.createElement("input");
			if (input instanceof HTMLInputElement) input.type = field.kind === "checkbox" ? "checkbox" : field.inputType ?? "text";
			if (input instanceof HTMLInputElement && input.type === "checkbox") { input.checked = field.value === "true"; label.classList.add("modal-checkbox"); }
			if (input instanceof HTMLInputElement && (field.inputType === "number" || field.inputType === "datetime-local")) input.step = "1";
			if (input instanceof HTMLInputElement && field.inputType === "password") {
				input.autocomplete = "off";
				input.spellcheck = false;
			}
			if (input instanceof HTMLSelectElement) for (const choice of field.options ?? []) {
				const option = document.createElement("option"); option.value = choice.value; option.textContent = choice.label; input.append(option);
			}
			if (field.readOnly === true && !(input instanceof HTMLSelectElement)) input.readOnly = true;
			// The file and JSON fields are code; prose instructions keep the text face.
			const code = field.id === "content" || field.id === "entry";
			input.className = field.kind === "checkbox" ? "modal-check" : field.kind === "textarea" ? `modal-textarea${code ? " code" : ""}` : "modal-input";
			input.value = field.value;
			if (field.placeholder !== undefined && !(input instanceof HTMLSelectElement)) input.placeholder = field.placeholder;
			inputs.set(field.id, input);
			fieldFocuses.push(input);
			label.append(input);
			if (field.description !== undefined) {
				const help = element("small", "modal-field-help", field.description);
				help.id = `modal-help-${field.id}`;
				input.setAttribute("aria-describedby", help.id);
				label.append(help);
			}
			body.append(label);
		}
		const visibility = (): void => {
			for (const field of modal.fields) {
				const input = inputs.get(field.id)!;
				const rules = field.visibleWhen === undefined ? [] : Array.isArray(field.visibleWhen) ? field.visibleWhen : [field.visibleWhen];
				const visible = rules.every(rule => rule.values.includes(inputs.get(rule.field)?.value ?? ""));
				input.disabled = !visible;
				fieldContainers.get(field.id)!.hidden = !visible;
			}
		};
		for (const input of inputs.values()) input.addEventListener("change", visibility);
		visibility();

		const foot = element("footer", "modal-foot");
		const cancel = button("panel-button weight-line");
		cancel.textContent = modal.dismiss ?? copy("panel.cancel");
		cancel.addEventListener("click", requestModalClose);
		const submit = button(`panel-button weight-filled${modal.danger === true ? " is-danger" : ""}`);
		submit.textContent = modal.submit ?? "";
		submit.addEventListener("click", () => {
			if (lastView?.panel.modal?.pending === true) return;
			const fields: Record<string, string> = {};
			for (const [id, input] of inputs) fields[id] = input instanceof HTMLInputElement && input.type === "checkbox" ? String(input.checked) : input.value;
			report({ kind: "modal-submit", id: modal.id, data: modal.data, fields });
		});
		card.addEventListener("keydown", (event) => {
			if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
			if (modal.submit !== undefined && event.key === "Enter" && event.target instanceof HTMLInputElement && !event.target.readOnly && !event.target.closest(".modal-multiselect, .directory-browser")) {
				event.preventDefault();
				submit.click();
			}
		});
		for (const action of modal.actions ?? []) if (action.placement === "start") foot.append(panelButton(action, report));
		foot.append(cancel);
		for (const action of modal.actions ?? []) if (action.placement !== "start") foot.append(panelButton(action, report));
		if (modal.submit !== undefined) foot.append(submit);
		const message = document.createElement("p");
		message.className = "modal-notice";
		message.hidden = true;
		card.append(head, body, message, foot);
		elements.modalRoot.replaceChildren(card);
		elements.modalRoot.hidden = false;
		if (!elements.modalRoot.open) elements.modalRoot.showModal();
		modalSubmit = modal.submit === undefined ? undefined : submit;
		modalMessage = message;
		applyModalState(modal);
		const first = modal.danger === true ? undefined : fieldFocuses.find(node => !node.closest("[hidden]") && !node.matches(":disabled"));
		if (modal.pending !== true) (first ?? cancel).focus();
		if (first instanceof HTMLTextAreaElement && first.readOnly) {
			first.setSelectionRange(0, 0);
			first.scrollTop = 0;
		}
	};

	/** Global destinations stay reachable when the contextual sidebar is collapsed. */
	const renderNav = (view: WebView): void => {
		const active = document.activeElement;
		const focusedView = active instanceof HTMLElement && elements.nav.contains(active) ? active.dataset.view : undefined;
		elements.nav.replaceChildren();
		const home: NavItem = { id: CHAT_VIEW, label: copy("nav.chat"), glyph: "chat", active: view.panel.current === CHAT_VIEW };
		for (const item of [home, ...view.panel.nav]) {
			if (item.id === SETTINGS_VIEW) continue;
			const row = button(item.active ? "rail-button active" : "rail-button");
			row.dataset.view = item.id;
			row.title = item.label;
			row.setAttribute("aria-label", item.label);
			if (item.active) row.setAttribute("aria-current", "page");
			row.append(icon(NAV_ICONS[item.glyph]));
			row.addEventListener("click", () => {
				report({ kind: "open", panel: item.id });
			});
			elements.nav.append(row);
			if (item.id === focusedView) row.focus({ preventScroll: true });
		}
		elements.settingsButton.replaceChildren(icon(NAV_ICONS.settings));
		elements.settingsButton.title = copy("nav.settings");
		elements.settingsButton.setAttribute("aria-label", copy("nav.settings"));
		elements.settingsButton.classList.toggle("active", view.panel.current === SETTINGS_VIEW);
		elements.settingsButton.hidden = !view.panel.nav.some(item => item.id === SETTINGS_VIEW);
		if (view.panel.current === SETTINGS_VIEW) elements.settingsButton.setAttribute("aria-current", "page");
		else elements.settingsButton.removeAttribute("aria-current");
	};

	/** The sidebar is a grid column: either collapsed out of the grid or expanded in it. */
	const sidebarExpanded = (): boolean => !document.body.classList.contains("sidebar-collapsed");

	/**
	 * An expanded sidebar holds the toggle in its own header: the session brand, or the section
	 * title. A collapsed one leaves it in the main header.
	 */
	const placeSidebarToggle = (): void => {
		const headerStart = elements.sessionTitle.closest(".header-start");
		const brand = elements.sessionSidebar.querySelector(":scope > .brand");
		const sectionHead = elements.sectionSidebar.querySelector(":scope > .section-sidebar-head");
		if (!(headerStart instanceof HTMLElement) || !(brand instanceof HTMLElement) || !(sectionHead instanceof HTMLElement)) return;
		const inColumn = sidebarExpanded();
		const host = !inColumn
			? headerStart
			: !elements.sessionSidebar.hidden
				? brand
				: !elements.sectionSidebar.hidden
					? sectionHead
					: headerStart;
		if (host === headerStart) headerStart.prepend(elements.sidebarToggle);
		else host.append(elements.sidebarToggle);
	};

	const syncSidebarToggle = (): void => {
		if (document.body.classList.contains("library-open")) {
			elements.sidebarToggle.setAttribute("aria-expanded", "false");
			return;
		}
		elements.sidebarToggle.setAttribute("aria-expanded", String(sidebarExpanded()));
		placeSidebarToggle();
	};

	/** Collapsing the sidebar hands its grid track to the conversation. */
	const toggleSidebar = (): void => {
		if (document.body.classList.contains("library-open")) return;
		document.body.classList.toggle("sidebar-collapsed");
		syncSidebarToggle();
	};

	const writeSessionTitle = (text: string): void => {
		elements.sessionTitle.textContent = text;
		elements.sessionTitle.title = text;
	};

	/** Interface settings lead the settings list; every other panel keeps the host's order. */
	const orderedGroups = (panel: PanelSpec): readonly PanelGroup[] =>
		panel.id === SETTINGS_VIEW
			? [...panel.groups.filter((group) => group.id === "settings:interface"), ...panel.groups.filter((group) => group.id !== "settings:interface")]
			: panel.groups;

	const revealLocatedRow = (groupId: string | undefined): void => {
		if (locatedRow === undefined || locatedRow.groupId !== groupId || locatedScrolled) return;
		const row = elements.viewBody.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(locatedRow.rowId)}"]`);
		if (row === null) return;
		row.classList.add("panel-row-located");
		const viewTop = elements.view.getBoundingClientRect().top;
		const viewBottom = elements.view.getBoundingClientRect().bottom;
		const rowBox = row.getBoundingClientRect();
		// Keep the matched row fully inside the pane. Centering can leave a sliver of the section title.
		if (rowBox.top < viewTop + 8 || rowBox.bottom > viewBottom - 8) elements.view.scrollTop += rowBox.top - viewTop - 8;
		locatedScrolled = true;
	};

	const markSectionNav = (selectedId: string | undefined): void => {
		const searching = !elements.sectionSearch.hidden && settingsQuery.trim().length > 0;
		const buttons = [...elements.sectionNav.querySelectorAll<HTMLButtonElement>("button")];
		if (searching) {
			for (const [index, row] of buttons.entries()) {
				const active = index === settingsHighlight;
				row.classList.toggle("active", active);
				row.setAttribute("aria-selected", String(active));
				row.removeAttribute("aria-current");
			}
			if (settingsHighlightFollow) {
				buttons[settingsHighlight]?.scrollIntoView({ block: "nearest" });
				settingsHighlightFollow = false;
			}
			return;
		}
		for (const row of buttons) {
			const active = row.dataset.groupId === selectedId;
			row.classList.toggle("active", active);
			if (active) row.setAttribute("aria-current", "true");
			else row.removeAttribute("aria-current");
			row.removeAttribute("aria-selected");
		}
	};

	const openSection = (panelId: string, groupId: string, rowId?: string): void => {
		const current = lastView;
		if (current?.panel.panel?.id !== panelId) return;
		sections.set(panelId, groupId);
		locatedRow = rowId === undefined ? undefined : { groupId, rowId };
		locatedScrolled = false;
		renderPanelView(current);
		if (rowId === undefined) elements.view.scrollTop = 0;
	};

	/** Categories, or the settings the query names. The search field itself stays put, so typing keeps focus. */
	const paintSectionNav = (view: WebView): void => {
		const panel = view.panel.panel;
		if (panel === undefined) return;
		const groups = orderedGroups(panel);
		const searching = panel.id === SETTINGS_VIEW && settingsQuery.trim().length > 0;
		elements.sectionSearch.hidden = panel.id !== SETTINGS_VIEW;
		elements.sectionSearchClear.hidden = settingsQuery.length === 0;
		if (changed("sections", [view.locale, panel.id, settingsQuery, groups])) {
			elements.sectionNav.replaceChildren();
			if (searching) {
				settingsHits = searchSettings(groups, settingsQuery);
				if (settingsHits.length === 0) elements.sectionNav.append(element("p", "empty-state", copy("panel.settings.searchEmpty")));
				else {
					for (const [index, hit] of settingsHits.entries()) {
						const stacked = hit.rowId !== undefined && hit.label !== hit.panelLabel;
						const row = button(stacked ? "nav-row nav-row-stack" : "nav-row");
						row.dataset.groupId = hit.groupId;
						row.dataset.searchIndex = String(index);
						if (hit.rowId !== undefined) row.dataset.rowId = hit.rowId;
						row.append(element("span", "nav-label", hit.label));
						if (stacked) row.append(element("span", "nav-detail", hit.panelLabel));
						row.setAttribute("aria-label", stacked ? copy("panel.settings.searchResult", { destination: hit.label, panel: hit.panelLabel }) : hit.label);
						row.addEventListener("click", () => {
							settingsHighlight = index;
							openSection(panel.id, hit.groupId, hit.rowId);
						});
						elements.sectionNav.append(row);
					}
				}
			} else {
				settingsHits = [];
				for (const group of groups) {
					const row = button("nav-row");
					row.dataset.groupId = group.id;
					row.append(element("span", "nav-label", group.title));
					row.addEventListener("click", () => openSection(panel.id, group.id));
					elements.sectionNav.append(row);
				}
			}
		}
		markSectionNav(sections.get(panel.id));
	};

	/** A library page keeps the session column and the inspector out of the grid. */
	const syncLibraryChrome = (view: WebView): void => {
		const library = view.panel.panel !== undefined;
		const was = document.body.classList.contains("library-open");
		document.body.classList.toggle("library-open", library);
		if (libraryNav) libraryNav.hidden = !library || view.panel.panel?.id !== SETTINGS_VIEW;
		elements.sidebarToggle.hidden = library;
		syncSidebarToggle();
		if (library && !was && view.panel.panel?.id === SETTINGS_VIEW) {
			elements.sectionSearch.hidden = false;
			elements.sectionSearchInput.focus({ preventScroll: true });
		}
	};

	/** Switch the main area between the conversation and one panel, and paint the panel. */
	const renderPanelView = (view: WebView): void => {
		const panel = view.panel.panel;
		const open = panel !== undefined;
		elements.sessionSidebar.hidden = open;
		elements.sectionSidebar.hidden = true;
		if (open) {
			setMeterExpanded(false);
			elements.meter.hidden = true;
			// A management page owns its own find chord; a chat search bar would be stale here.
			elements.transcriptSearch.hidden = true;
			elements.transcriptSearchInput.value = "";
			elements.transcriptSearchCount.textContent = "";
			for (const marked of elements.transcript.querySelectorAll(".search-hit")) marked.classList.remove("search-hit");
		}
		elements.runActions.hidden = open;
		elements.laneStatus.hidden = open || view.lane.length === 0;
		elements.view.hidden = !open;
		elements.transcript.hidden = open;
		elements.composerDock.hidden = open;
		elements.viewBack.hidden = !open;
		elements.sessionTitle.hidden = open;
		if (panel === undefined) {
			panelFocus.delete(elements.viewBody);
			shownSection = "";
			locatedRow = undefined;
			locatedScrolled = false;
			elements.viewBody.replaceChildren();
			const label = view.sessionLabel ?? copy("header.noSession");
			writeSessionTitle(
				view.focus === undefined
					? label
					: copy("header.conversation", {
							session: label,
							conversation: view.focus,
						}),
			);
			return;
		}
		elements.sectionTitle.textContent = panel.title;
		const groups = orderedGroups(panel);
		const selected = groups.find((group) => group.id === sections.get(panel.id)) ?? groups[0];
		if (selected) sections.set(panel.id, selected.id);
		paintSectionNav(view);
		const section = `${panel.id}:${selected?.id ?? ""}`;
		if (shownSection !== section) elements.view.scrollTop = 0;
		shownSection = section;
		if (selected) {
			if (selected.id === "settings:models" && view.modelConnections) {
				if (elements.viewBody.firstElementChild !== connections.element) elements.viewBody.replaceChildren(connections.element);
				connections.update(view.locale, view.modelConnections, shownNotices(panel.id, panel.notices));
				return;
			}
			const { title, description, actions, ...content } = selected;
			// The category column already names the open section. Repeating that title and its blurb is the same fact twice.
			const namedByNav = panel.id === SETTINGS_VIEW;
			replacePanel(elements.viewBody, {
				...panel,
				title: namedByNav ? "" : title,
				description: namedByNav ? undefined : description ?? panel.description,
				actions,
				groups: [{ ...content, title: "" }],
			});
		} else replacePanel(elements.viewBody, panel);
		revealLocatedRow(selected?.id);
	};

	/** Send stays send. It is disabled when there is nothing to send. */
	const canCompose = (view: WebView | undefined): boolean => view !== undefined && view.readOnly !== true
		&& (view.sessionDraft === undefined ? view.attachedId !== undefined : !view.sessionDraft.disabled);
	const renderPrimary = (): void => {
		const pending = lastView?.attachments.length ?? 0;
		elements.primary.disabled = !canCompose(lastView) || (lastView?.sessionDraft !== undefined && (lastView.model.disabled || lastView.model.groups.length === 0)) || (draft().length === 0 && pending === 0);
	};

	/** The stop control is on screen for the whole turn, whether or not the draft is empty. */
	const renderStop = (): void => {
		const busy = lastView?.busy === true && lastView.attachedId !== undefined;
		elements.stop.hidden = !busy;
		elements.stop.disabled = !busy;
		const keys = lastView?.shortcuts.find((row) => row.id === "run.stop")?.keys;
		elements.stop.title = keys === undefined ? copy("composer.stop") : `${copy("composer.stop")} (${keys})`;
	};

	/**
	 * Pending approvals in the header. The cards above the composer stay the place to answer;
	 * this mark remains when the transcript is empty or those cards are scrolled out of view.
	 */
	const renderApprovalStatus = (view: WebView): void => {
		const indicator = view.approvalIndicator;
		if (indicator === undefined) {
			elements.approvalStatus.hidden = true;
			elements.approvalStatus.textContent = "";
			elements.approvalStatus.removeAttribute("aria-label");
			return;
		}
		elements.approvalStatus.hidden = false;
		elements.approvalStatus.textContent = indicator.label;
		elements.approvalStatus.setAttribute("aria-label", indicator.label);
	};

	/** Context %, tokens, and cost. Shown once usage exists; detailed figures sit in the disclosure. */
	const renderMeter = (view: WebView): void => {
		const hasTokens = !view.meter.tokens.startsWith("? /");
		const hasCost = view.meter.cost !== "$0.000";
		const hasContext = view.meter.context !== "?";
		const hasUsage = view.attachedId !== undefined && view.panel.panel === undefined && (hasContext || hasTokens || hasCost);
		if (!hasUsage) {
			setMeterExpanded(false);
			elements.meter.hidden = true;
			return;
		}
		const usedTokens = view.meter.tokens.split(" / ")[0] ?? view.meter.tokens;
		const summaryText = hasContext ? view.meter.context : hasTokens ? `${usedTokens} tokens` : view.meter.cost;
		const displayTokens = view.meter.tokens.endsWith(" / ?") ? usedTokens : view.meter.tokens;
		elements.meterContext.textContent = summaryText;
		elements.meterTokens.textContent = displayTokens;
		elements.meterCost.textContent = view.meter.cost;
		meterNodes.tokensLabel.textContent = copy("header.meterTokens");
		meterNodes.costLabel.textContent = copy("header.meterCost");
		if (elements.meterTokens.parentElement) elements.meterTokens.parentElement.hidden = !hasTokens;
		elements.meter.dataset.tone = view.meter.tone;
		const meterLabel = copy("header.meter", {
			context: view.meter.context,
			tokens: displayTokens,
			cost: view.meter.cost,
		});
		elements.meter.setAttribute("aria-label", meterLabel);
		elements.meter.title = meterLabel;
		meterNodes.trigger.title = meterLabel;
		meterNodes.trigger.setAttribute("aria-label", `${copy("header.meterToggle")}: ${meterLabel}`);
		elements.meter.hidden = false;
	};

	/** A disclosure whose open state is the reader's, falling back to a per-block default. */
	const disclosure = (block: TranscriptBlock, className: string, defaultOpen: boolean): HTMLDetailsElement => {
		const details = document.createElement("details");
		details.className = `disclosure ${className}`.trim();
		details.open = expanded.get(block.id) ?? defaultOpen;
		// Only the reader's press on the summary is a choice. The click runs before the browser flips
		// `open`, so the intent is the flipped value. A click in the open body is not a choice, and a
		// block that starts open (a running tool) is not one either, so neither is recorded.
		details.addEventListener("click", (event) => {
			const target = event.target;
			if (target instanceof Element && target.closest("summary") !== null) expanded.set(block.id, !details.open);
		});
		return details;
	};

	/** Writes an answer's text to the clipboard; the control shows the outcome for a moment. */
	const copyAnswer = (control: HTMLButtonElement, text: string, label: MessageKey = "copy.copy"): void => {
		const show = (key: MessageKey, glyph: IconName): void => {
			control.title = copy(key);
			control.setAttribute("aria-label", copy(key));
			control.replaceChildren(icon(glyph));
			if (control.dataset.copyLabel === "visible") control.append(element("span", "copy-label", copy(key)));
			window.setTimeout(() => {
				control.title = copy(label);
				control.setAttribute("aria-label", copy(label));
				control.replaceChildren(icon("copy"));
				if (control.dataset.copyLabel === "visible") control.append(element("span", "copy-label", copy(label)));
			}, 1200);
		};
		const written = navigator.clipboard?.writeText(text);
		if (written === undefined) {
			show("copy.failed", "x");
			return;
		}
		void written.then(
			() => show("copy.copied", "check"),
			() => show("copy.failed", "x"),
		);
	};

	/** One rating control: the thumb, pressed when it is the rating the answer carries. */
	const feedbackControl = (action: PanelButton, direction: "up" | "down", selected: boolean): HTMLElement => {
		const node = panelButton(action, report);
		node.className = selected ? "message-action selected" : "message-action";
		node.replaceChildren(icon(direction === "up" ? "thumb-up" : "thumb-down"));
		node.title = action.label;
		node.setAttribute("aria-label", action.label);
		node.setAttribute("aria-pressed", String(selected));
		return node;
	};

	/** The row under an answer: copy it, then the two ratings when the host keeps them. */
	const answerActions = (block: TranscriptBlock): HTMLElement => {
		const row = element("div", "turn-actions");
		const copyControl = button("message-action");
		const ranges = block.kind === "user" ? credentialRanges(block.text) : [];
		const label = ranges.length > 0 ? "copy.sensitive" : "copy.copy";
		copyControl.title = copy(label);
		copyControl.setAttribute("aria-label", copy(label));
		copyControl.append(icon("copy"));
		if (ranges.length > 0) {
			copyControl.classList.add("copy-sensitive");
			copyControl.dataset.copyLabel = "visible";
			copyControl.append(element("span", "copy-label", copy(label)));
		}
		copyControl.addEventListener("click", () => copyAnswer(copyControl, block.text, label));
		row.append(copyControl);
		if (ranges.length > 0) {
			const masked = button("message-action copy-masked");
			masked.dataset.copyLabel = "visible";
			masked.title = copy("copy.masked");
			masked.setAttribute("aria-label", masked.title);
			masked.append(icon("copy"), element("span", "copy-label", masked.title));
			let from = 0, text = "";
			for (const range of ranges) {
				text += block.text.slice(from, range.start) + range.masked;
				from = range.end;
			}
			text += block.text.slice(from);
			masked.addEventListener("click", () => copyAnswer(masked, text, "copy.masked"));
			row.append(masked);
		}
		if (block.feedback !== undefined) {
			row.append(
				feedbackControl(block.feedback.up, "up", block.feedback.rating === "up"),
				feedbackControl(block.feedback.down, "down", block.feedback.rating === "down"),
			);
		}
		return row;
	};

	/** One creation control for welcome and detached states; it follows the host's availability. */
	const createSessionButton = (view: WebView, action: PanelButton): HTMLButtonElement => {
		const pending = view.newSession.pending === true;
		const control = panelButton({ ...action, label: pending ? copy("sidebar.creating") : action.label, disabled: action.disabled === true || !view.newSession.enabled || pending }, report);
		control.setAttribute("aria-busy", String(pending));
		if (pending) control.prepend(icon("spinner", "icon spin"));
		return control;
	};

	/** The first-run guide offers only actions that work before a session is attached. */
	const welcomeElement = (view: WebView, welcome: WelcomeCard): HTMLElement => {
		const card = element("div", "welcome-card");
		const mark = element("span", "brand-mark welcome-mark");
		mark.append(pixelLogo());
		card.append(mark, element("h2", "welcome-title", welcome.title), element("p", "welcome-body", welcome.body));
		const steps = element("div", "welcome-steps");
		for (const step of welcome.steps) steps.append(step.id === WELCOME_SESSION_ACTION ? createSessionButton(view, step) : panelButton(step, report));
		card.append(steps, element("p", "welcome-note", welcome.note));
		const dismiss = panelButton(welcome.dismiss, report);
		dismiss.className = "welcome-dismiss";
		card.append(dismiss);
		return card;
	};

	/**
	 * The conversation's empty state. A session with nothing in it greets the reader above the
	 * composer. With no session attached, the state says how to get one.
	 */
	const emptyElement = (view: WebView): HTMLElement => {
		const block = element("div", "empty-block");
		block.id = "transcript-empty";
		if (view.sessionDraft !== undefined) {
			block.append(element("h2", "greeting", view.sessionDraft.projectId === null
				? copy("greeting.standaloneDraft") : copy("greeting.projectDraft", { name: view.sessionDraft.label })));
			return block;
		}
		if (view.attachedId !== undefined) {
			block.append(element("h2", "greeting", copy(view.readOnly ? "greeting.readOnlyTitle" : "greeting.title")), element("p", "greeting-hint", copy(view.readOnly ? "greeting.readOnlyHint" : "greeting.hint")));
			if (view.readOnly) {
				const actions = element("div", "welcome-steps");
				actions.append(panelButton(view.archivedAttached
					? { id: SESSION_RESTORE_ACTION, data: view.attachedId, label: copy("project.restore"), weight: "filled" }
					: { id: DOCK_TAB_ACTION, data: "conversations", label: copy("greeting.openConversations"), weight: "filled" }, report));
				block.append(actions);
			} else if (view.model.empty !== undefined) {
				const scopeEmpty = view.model.empty === copy("model.scopeEmpty");
				const actions = element("div", "welcome-steps");
				if (scopeEmpty) {
					actions.append(
						panelButton({ id: MODEL_SCOPE_ACTION, label: copy("model.configureModels"), weight: "filled", disabled: view.model.disabled }, () => triggerModelSetup(MODEL_SCOPE_ACTION)),
						panelButton({ id: MODEL_CONNECTIONS_ACTION, label: copy("model.connectProvider"), weight: "line", disabled: view.model.disabled }, () => triggerModelSetup(MODEL_CONNECTIONS_ACTION)),
					);
				} else {
					actions.append(
						panelButton({ id: MODEL_CONNECTIONS_ACTION, label: copy("model.connectProvider"), weight: "filled", disabled: view.model.disabled }, () => triggerModelSetup(MODEL_CONNECTIONS_ACTION)),
					);
				}
				block.append(element("p", "greeting-hint", view.model.empty), actions);
			}
			return block;
		}
		const unavailable = !view.newSession.enabled && view.newSession.pending !== true;
		const filtered = view.rosterFilter.trim().length > 0 && view.roster.length === 0;
		const hasSessions = view.roster.length > 0;
		const title = unavailable ? "greeting.waitTitle" : filtered ? "greeting.filterTitle" : hasSessions ? "greeting.pickTitle" : "greeting.startTitle";
		const hint = unavailable ? "greeting.waitHint" : filtered ? "greeting.filterHint" : hasSessions ? "greeting.pickHint" : "greeting.startHint";
		block.append(element("h2", "greeting", copy(title)), element("p", "greeting-hint", copy(hint)));
		if (unavailable) return block;
		const actions = element("div", "welcome-steps");
		if (filtered) {
			const clear = button("panel-button weight-filled");
			clear.textContent = copy("greeting.clearFilter");
			clear.addEventListener("click", () => {
				elements.rosterFilter.value = "";
				renderer.onFilterRoster("");
			});
			actions.append(clear);
		} else {
			if (hasSessions) {
				const pick = button("panel-button weight-filled");
				pick.textContent = copy("greeting.pickAction");
				pick.addEventListener("click", () => {
					if (!sidebarExpanded()) toggleSidebar();
					elements.roster.querySelector<HTMLButtonElement>(".session-select")?.focus();
				});
				actions.append(pick);
			}
			actions.append(createSessionButton(view, { id: WELCOME_SESSION_ACTION, label: copy("sidebar.newSession"), weight: hasSessions ? "line" : "filled" }));
		}
		block.append(actions);
		return block;
	};

	/** Original values stay in closures, never in attributes or a second transcript representation. */
	const userText = (text: string, className: string): HTMLElement => {
		const node = element("span", className);
		let from = 0;
		for (const range of credentialRanges(text)) {
			node.append(document.createTextNode(text.slice(from, range.start)));
			const secret = element("span", "credential-secret");
			const value = element("span", "credential-value", range.masked);
			const toggle = button("credential-toggle");
			let shown = false;
			const paint = (): void => {
				value.textContent = shown ? text.slice(range.start, range.end) : range.masked;
				toggle.textContent = copy(shown ? "secret.hide" : "secret.show");
				toggle.setAttribute("aria-label", copy(shown ? "secret.hideAria" : "secret.showAria"));
				toggle.setAttribute("aria-pressed", String(shown));
			};
			toggle.addEventListener("click", () => { shown = !shown; paint(); });
			paint();
			secret.append(value, toggle);
			node.append(secret);
			from = range.end;
		}
		node.append(document.createTextNode(text.slice(from)));
		return node;
	};

	/** A user turn: the images the entry carries, then its display-only masked text. */
	const userBubble = (block: TranscriptBlock): HTMLElement => {
		const bubble = element("div", "bubble");
		for (const image of block.images ?? []) {
			const node = document.createElement("img");
			node.className = "bubble-image";
			node.src = image.dataUrl;
			node.alt = image.alt;
			bubble.append(node);
		}
		if (block.text.length > 0) bubble.append(userText(block.text, "bubble-text"));
		return bubble;
	};

	/** A process row's summary: the leading mark, the title, one line of what it is about, and the chevron. */
	const disclosureSummary = (mark: SVGSVGElement, title: string, summary: string): HTMLElement => {
		const line = element("summary", "disclosure-row");
		const lead = element("span", "disclosure-leading");
		lead.append(mark);
		line.append(lead, element("span", "disclosure-title", title), element("span", "disclosure-summary", summary), icon("chevron-down", "icon disclosure-chevron"));
		return line;
	};

	const showImage = (source: string, alt: string): HTMLDialogElement => {
		const dialog = document.createElement("dialog");
		dialog.className = "tool-image-dialog";
		dialog.setAttribute("aria-label", copy("tool.viewImage"));
		const close = button("tool-image-close");
		close.setAttribute("aria-label", copy("tool.closeImage"));
		close.append(icon("x"));
		close.addEventListener("click", () => dialog.close());
		const image = document.createElement("img");
		image.src = source;
		image.alt = alt;
		dialog.append(close, image);
		dialog.addEventListener("close", () => dialog.remove(), { once: true });
		dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
		document.body.append(dialog);
		dialog.showModal();
		return dialog;
	};

	/** A persisted file change. Line numbers and signs come from the recorded diff, not a preview. */
	const diffElement = (diff: NonNullable<NonNullable<TranscriptBlock["result"]>["diff"]>, key: string): HTMLElement => {
		const container = element("section", "tool-diff");
		const header = element("div", "tool-result-heading");
		const meta = element("div", "reader-meta", diff.label);
		if (diff.path) meta.append(element("span", "tool-result-path", diff.path));
		const actions = element("div", "reader-controls");
		header.append(meta, actions);
		const code = element("pre", "tool-diff-code");
		code.dataset.textKey = "diff";
		for (const [index, line] of diff.text.split("\n").entries()) {
			if (index > 0) code.append(document.createTextNode("\n"));
			const tone = line.startsWith("+++ ") || line.startsWith("--- ") ? "diff-header"
				: line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") ? "addition" : line.startsWith("-") ? "removal" : "context";
			code.append(element("span", `tool-diff-line ${tone}`, line));
		}
		container.append(header, code);
		reading.attach({ key, root: container, content: code, toolbar: actions, text: diff.patch ?? diff.text,
			copyLabel: diff.patch === undefined ? "dock.copyContents" : "tool.copyPatch", lineCount: diff.text.split("\n").length });
		return container;
	};

	/** A tool call: the requested arguments and its executed output have separate presentation. */
	const toolElement = (block: TranscriptBlock): HTMLElement => {
		const tone = block.running ? "running" : block.tone === "error" ? "error" : "";
		const details = disclosure(block, tone, block.running);
		details.dataset.blockId = String(block.id);
		const digest = block.toolArgs?.collapsed;
		const summary = digest !== undefined && digest.length > 0 ? digest : firstLine(block.text || block.result?.diagnostics[0]?.text || "");
		const mark = block.running ? icon("spinner", "icon spin") : block.tone === "error" ? icon("alert") : icon("wrench");
		const heading = disclosureSummary(mark, block.title, summary);
		if (block.toolName !== undefined) heading.title = block.toolName;
		details.append(heading);
		if (block.toolArgs !== undefined && block.toolArgs.expanded.length > 0) {
			const args = element("div", "tool-args", block.toolArgs.expanded);
			args.dataset.textKey = "args";
			const controls = element("div", "tool-result-heading");
			const copyArgs = button("message-action");
			copyArgs.title = copy("tool.copyArgs");
			copyArgs.setAttribute("aria-label", copyArgs.title);
			copyArgs.append(icon("copy"));
			copyArgs.addEventListener("click", () => copyAnswer(copyArgs, block.toolArgs!.source, "tool.copyArgs"));
			controls.append(copyArgs);
			details.append(controls, args);
		}
		if (block.result !== undefined) {
			const meta = element("div", "tool-result-meta");
			for (const label of [block.result.nested, block.result.status, block.result.duration, block.result.terminal?.exit]) {
				if (label) meta.append(element("span", "tool-result-tag", label));
			}
			details.append(meta);
			const terminal = block.result.terminal;
			if (terminal?.command) {
				const command = element("pre", "tool-command", terminal.command);
				if (terminal.cwd) command.title = terminal.cwd;
				details.append(command);
			}
			if (block.result.diff) details.append(diffElement(block.result.diff, `diff:${block.id}`));
		}
		if (block.text.length > 0) {
			const output = element("div", block.result?.terminal === undefined ? "tool-output" : "tool-output terminal-output", block.text);
			output.dataset.textKey = "output";
			const controls = element("div", "tool-result-heading");
			const reader = element("section", "tool-output-reader");
			reader.append(controls, output);
			reading.attach({ key: `output:${block.id}`, root: reader, content: output, toolbar: controls, text: block.text, copyLabel: "tool.copyOutput" });
			details.append(reader);
		} else if (!block.running && (block.images?.length ?? 0) === 0 && (block.result?.diagnostics.length ?? 0) === 0) {
			details.append(element("div", "tool-output empty", copy("tool.noOutput")));
		}
		if (block.images && block.images.length > 0) {
			const gallery = element("div", "tool-images");
			for (const item of block.images) {
				const control = button("tool-image");
				control.setAttribute("aria-label", copy("tool.viewImage"));
				const image = document.createElement("img");
				image.src = item.dataUrl;
				image.alt = item.alt;
				image.loading = "lazy";
				control.append(image);
				control.addEventListener("click", () => showImage(item.dataUrl, item.alt));
				gallery.append(control);
			}
			details.append(gallery);
		}
		for (const diagnostic of block.result?.diagnostics ?? []) details.append(element("p", `tool-diagnostic ${diagnostic.tone}`, diagnostic.text));
		return details;
	};

	/** Assistant reasoning: the Thinking row, collapsed until the reader opens it. */
	const reasoningElement = (block: TranscriptBlock): HTMLElement => {
		const details = disclosure(block, "", false);
		details.dataset.blockId = String(block.id);
		const body = element("div", "reasoning-body", block.text);
		body.dataset.textKey = "reasoning";
		details.append(disclosureSummary(icon("sparkles"), block.title, ""), body);
		return details;
	};

	const sessionMenuTrigger = (id: string): HTMLButtonElement | undefined =>
		[...document.querySelectorAll<HTMLButtonElement>(".session-more, .project-more, .panel-more")].find((node) => (node.dataset.menuId ?? node.dataset.actionData) === id);

	const closeSessionMenu = (restoreFocus = false): void => {
		const opened = sessionMenu;
		if (opened === undefined) return;
		opened.node.remove();
		sessionMenu = undefined;
		const trigger = sessionMenuTrigger(opened.id);
		trigger?.setAttribute("aria-expanded", "false");
		if (restoreFocus) trigger?.focus();
	};

	const positionSessionMenu = (): void => {
		if (sessionMenu === undefined) return;
		const trigger = sessionMenuTrigger(sessionMenu.id);
		if (trigger === undefined || trigger.closest("[hidden]") !== null) {
			closeSessionMenu();
			return;
		}
		trigger.setAttribute("aria-expanded", "true");
		const rect = trigger.getBoundingClientRect();
		const height = sessionMenu.node.offsetHeight;
		sessionMenu.node.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 220))}px`;
		sessionMenu.node.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
	};

	const openRosterMenu = (id: string, data: string, label: string,
		actions: readonly { readonly id: string; readonly label: string; readonly glyph: IconName; readonly danger?: boolean; readonly disabled?: boolean }[]): void => {
		if (sessionMenu?.id === id) {
			closeSessionMenu(true);
			return;
		}
		closeSessionMenu();
		const menu = element("div", "session-menu");
		menu.id = "session-actions";
		menu.setAttribute("role", "menu");
		menu.setAttribute("aria-label", label);
		for (const action of actions) {
			const control = button(action.danger ? "session-menu-item danger" : "session-menu-item");
			control.dataset.action = action.id;
			control.dataset.actionData = data;
			control.setAttribute("role", "menuitem");
			control.disabled = action.disabled === true;
			control.tabIndex = -1;
			const label = element("span", "", action.label);
			control.append(icon(action.glyph), label);
			control.addEventListener("click", () => {
				if (action.id === SESSION_COPY_ID_ACTION) {
					const result = navigator.clipboard?.writeText(data);
					label.setAttribute("aria-live", "polite");
					if (result === undefined) label.textContent = copy("copy.failed");
					else void result.then(
						() => { label.textContent = copy("copy.copied"); },
						() => { label.textContent = copy("copy.failed"); },
					);
					return;
				}
				closeSessionMenu(true);
				report({ kind: "command", id: action.id, data });
			});
			menu.append(control);
		}
		menu.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeSessionMenu(true);
				return;
			}
			if (event.key === "Tab") {
				closeSessionMenu(true);
				return;
			}
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const controls = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
			const index = controls.findIndex((node) => node === document.activeElement);
			const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + controls.length) % controls.length;
			controls[next]?.focus();
		});
		sessionMenu = { id, node: menu };
		document.body.append(menu);
		positionSessionMenu();
		menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
	};
	const openSessionMenu = (item: RosterItem): void => openRosterMenu(item.id, item.id, copy("sidebar.more"), [
		{ id: SESSION_RENAME_ACTION, label: copy("sidebar.rename"), glyph: "square-pen" },
		...(lastView?.projects === undefined ? [] : [{ id: item.archived ? SESSION_RESTORE_ACTION : SESSION_ARCHIVE_ACTION, label: copy(item.archived ? "project.restore" : "project.archive"), glyph: "folder" as const }]),
		{ id: SESSION_COPY_ID_ACTION, label: copy("sidebar.copyId"), glyph: "copy" },
		{ id: item.remove.id, label: item.remove.label, glyph: "x", danger: true },
	]);

	/** Selection and the menu are sibling buttons, so neither nests an interactive control. */
	const sessionRow = (item: RosterItem): HTMLElement => {
		const row = element("div", item.attached ? "session-row attached" : "session-row");
		row.dataset.sessionId = item.id;
		const select = button("session-select");
		select.title = [item.label, item.cwd].filter(Boolean).join(" · ");
		if (item.attached) select.setAttribute("aria-current", "true");
		const name = element("span", "session-name", item.label);
		if (item.source === "local") name.append(element("span", "session-source", copy("sidebar.localSession")));
		const age = element("time", "session-age", item.age);
		age.setAttribute("datetime", item.ageIso);
		select.append(name, age);
		select.addEventListener("click", () => {
			closeSessionMenu();
			renderer.onSelect(item.id);
		});
		const more = button("session-more");
		more.dataset.action = "session:more";
		more.dataset.actionData = item.id;
		more.title = copy("sidebar.more");
		more.setAttribute("aria-label", `${copy("sidebar.more")}: ${item.label}`);
		more.setAttribute("aria-haspopup", "menu");
		more.setAttribute("aria-controls", "session-actions");
		more.setAttribute("aria-expanded", String(sessionMenu?.id === item.id));
		more.append(icon("more"));
		more.addEventListener("click", () => openSessionMenu(item));
		more.addEventListener("keydown", (event) => {
			if (event.key !== "ArrowDown") return;
			event.preventDefault();
			openSessionMenu(item);
		});
		row.append(select, more);
		return row;
	};

	/** A fenced code block: numbered syntax tokens with the same reading controls as tool results. */
	const codeBlockElement = (text: string, language: string | undefined, foldKey?: string): HTMLElement => {
		const tokenizedLines = tokenizeCode(text, language);
		const lineCount = tokenizedLines.length;
		const block = element("div", "code-block");
		const head = element("div", "code-head");
		const meta = element("div", "code-meta");
		if (language !== undefined) meta.append(element("span", "code-language", language));
		meta.append(element("span", "code-lines", copy("code.lines", { count: String(lineCount) })));
		const actions = element("div", "code-actions");
		head.append(meta, actions);
		block.append(head);
		const pre = document.createElement("pre");
		const code = document.createElement("code");
		if (language !== undefined) code.dataset.language = language;
		for (const [lineIndex, tokens] of tokenizedLines.entries()) {
			if (lineIndex > 0) code.append(document.createTextNode("\n"));
			const line = element("span", "code-line");
			line.dataset.line = String(lineIndex + 1);
			for (const token of tokens) {
				if (token.kind === "plain") line.append(document.createTextNode(token.text));
				else line.append(element("span", `tok-${token.kind}`, token.text));
			}
			code.append(line);
		}
		pre.append(code);
		block.append(pre);
		reading.attach({ key: `code:${foldKey ?? text}`, root: block, content: pre, toolbar: actions, text, copyLabel: "copy.code", lineCount });
		return block;
	};

	/** What the markdown adapter borrows from the renderer. */
	const markdownFor = (blockId: string): MarkdownContext => ({
		copy,
		codeBlock: (text, language, index = 0) => codeBlockElement(text, language, `${blockId}:${index}`),
	});

	/** The tool calls waiting for a decision: what wants to run, and the two ways to answer. */
	const renderApprovals = (view: WebView): void => {
		elements.approvals.replaceChildren();
		if (view.approvals.length === 0) {
			elements.approvals.hidden = true;
			return;
		}
		for (const card of view.approvals) {
			const node = element("div", "approval-card");
			node.dataset.approvalId = card.id;
			const head = element("div", "approval-head");
			head.append(element("p", "approval-title", copy("approval.title")), element("p", "approval-tool", copy("approval.tool", { tool: card.tool })));
			node.append(head);
			node.append(element("pre", "approval-detail", card.detail));
			const actions = element("div", "approval-actions");
			actions.append(panelButton(card.deny, report), panelButton(card.approve, report));
			node.append(actions);
			node.append(element("p", "approval-hint", copy("approval.hint")));
			elements.approvals.append(node);
		}
		elements.approvals.hidden = false;
	};

	/** The command palette: the host's commands (or their argument completions) for this draft. */
	const renderPalette = (view: WebView): void => {
		if (!view.palette.open || (lastView?.attachedId === undefined && view.palette.rows.length === 0)) {
			elements.palette.replaceChildren();
			elements.palette.hidden = true;
			return;
		}
		const card = element("div", "palette-card");
		card.append(element("p", "palette-title", view.palette.title));
		if (view.palette.empty !== undefined) card.append(element("p", "palette-empty", view.palette.empty));
		const rows = element("div", "palette-rows");
		view.palette.rows.forEach((row, index) => {
			const classes = ["palette-row"];
			if (row.selected) classes.push("selected");
			const node = button(classes.join(" "));
			node.dataset.value = row.value;
			// Every row carries the tag slot, so the names keep one left edge whether or not the
			// command came from a resource.
			node.append(element("span", "palette-tag", row.tag ?? ""));
			node.append(element("span", "palette-name", row.label));
			if (row.hint !== undefined) node.append(element("span", "palette-hint", row.hint));
			node.append(element("span", "palette-desc", row.description));
			// Hovering moves the highlight, so the reader's next Enter takes what they point at.
			node.addEventListener("pointerenter", () => renderer.onPaletteSelection(index));
			node.addEventListener("click", () => renderer.onCommandPick(row.value));
			rows.append(node);
		});
		card.append(rows);
		card.append(element("p", "palette-foot", copy("palette.hint")));
		elements.palette.replaceChildren(card);
		elements.palette.hidden = false;
	};

	/** The open preview, so taking the picture away or leaving the session closes it. */
	let attachmentPreview: { readonly attachmentId: string; readonly scope: string; readonly dialog: HTMLDialogElement } | undefined;
	const attachmentScope = (view: WebView): string => view.transcriptScope ?? view.attachedId ?? "";
	const closeAttachmentPreview = (): void => {
		const preview = attachmentPreview;
		attachmentPreview = undefined;
		preview?.dialog.close();
	};

	/** The pending images: each thumbnail carries its own remove, and none is sent until submit. */
	const renderAttachments = (view: WebView): void => {
		elements.attachments.replaceChildren();
		if (view.attachments.length === 0) {
			elements.attachments.hidden = true;
			return;
		}
		for (const attachment of view.attachments) elements.attachments.append(attachmentElement(attachment));
		elements.attachments.hidden = false;
	};

	const attachmentElement = (attachment: Attachment): HTMLElement => {
		const card = element("figure", "attachment");
		card.dataset.attachmentId = attachment.id;
		// The picture is the control: a button, so Enter and Space open the preview too.
		const preview = button("attachment-preview");
		preview.title = copy("composer.previewAttachment");
		preview.setAttribute("aria-label", preview.title);
		const image = document.createElement("img");
		image.src = attachment.dataUrl;
		image.alt = attachment.name;
		preview.append(image);
		preview.addEventListener("click", () => {
			closeAttachmentPreview();
			if (lastView === undefined) return;
			const dialog = showImage(attachment.dataUrl, attachment.name);
			const scope = attachmentScope(lastView);
			attachmentPreview = { attachmentId: attachment.id, scope, dialog };
			dialog.addEventListener("close", () => {
				if (attachmentPreview?.dialog !== dialog) return;
				attachmentPreview = undefined;
				// Another file may finish reading while the dialog is open and replace the opener.
				if (lastView === undefined || attachmentScope(lastView) !== scope || elements.composerDock.hidden) return;
				const card = Array.from(elements.attachments.querySelectorAll<HTMLElement>("[data-attachment-id]"))
					.find(node => node.dataset.attachmentId === attachment.id);
				card?.querySelector<HTMLButtonElement>(".attachment-preview")?.focus({ preventScroll: true });
			}, { once: true });
		});
		card.append(preview);
		const meta = element("figcaption", "attachment-meta");
		meta.append(element("span", "attachment-name", attachment.name), element("span", "attachment-size", attachment.size));
		card.append(meta);
		const remove = panelButton(attachment.remove, report);
		remove.className = "attachment-remove";
		// The strip shows a mark; the control's name is the accessible one.
		remove.replaceChildren(icon("x"));
		remove.title = attachment.remove.label;
		remove.setAttribute("aria-label", attachment.remove.label);
		card.append(remove);
		return card;
	};

	/** One queued input: what it is, and the withdraw that names only this submission. */
	const queueElement = (item: QueueItem): HTMLElement => {
		const row = element("p", "queue-item");
		row.dataset.submissionId = item.id;
		row.append(userText(item.text, "queue-text"));
		const cancel = panelButton(item.cancel, report);
		cancel.className = "queue-cancel";
		cancel.title = copy("queue.cancelAria");
		cancel.setAttribute("aria-label", copy("queue.cancelAria"));
		row.append(cancel);
		return row;
	};

	/** The dock: the tabs, the open tab's panel, and the class that gives it a column. */
	const renderDock = (view: WebView): void => {
		const open = view.dock.open && view.panel.current === CHAT_VIEW;
		elements.dock.setAttribute("aria-label", copy("dock.toggle"));
		elements.dock.hidden = !open;
		document.body.classList.toggle("dock-open", open);
		if (!open) {
			panelFocus.delete(elements.dockBody);
			elements.dockTabs.replaceChildren();
			elements.dockBody.replaceChildren();
			positionSessionMenu();
			return;
		}
		const tabsChanged = changed("dock-tab-labels", [view.locale, view.dock.tabs.map(tab => [tab.id, tab.label])]);
		if (!elements.dockTabs.firstElementChild || tabsChanged) {
			const tabs = element("div", "dock-tab-row");
			tabs.setAttribute("role", "tablist");
			for (const tab of view.dock.tabs) {
				const node = button("dock-tab");
				node.dataset.tab = tab.id;
				node.id = `dock-tab-${tab.id}`;
				node.title = tab.label;
				node.setAttribute("role", "tab");
				node.setAttribute("aria-controls", elements.dockBody.id);
				node.append(icon(DOCK_ICONS[tab.id]), element("span", "dock-tab-label", tab.label));
				node.addEventListener("click", () => report({ kind: "command", id: DOCK_TAB_ACTION, data: tab.id }));
				node.addEventListener("keydown", event => {
					const target = groupKeyTarget(event, node);
					if (target) { target.focus(); report({ kind: "command", id: DOCK_TAB_ACTION, data: target.dataset.tab }); }
				});
				tabs.append(node);
			}
			const close = button("icon-button dock-close");
			close.id = "dock-close";
			close.title = copy("dock.close");
			close.setAttribute("aria-label", close.title);
			close.append(icon("x"));
			close.addEventListener("click", () => report({ kind: "command", id: DOCK_TOGGLE_ACTION, data: undefined }));
			elements.dockTabs.replaceChildren(tabs, close);
		}
		const selectionChanged = changed("dock-tab-selection", view.dock.tabs.find(tab => tab.active)?.id);
		for (const node of elements.dockTabs.querySelectorAll<HTMLButtonElement>(".dock-tab")) {
			const active = view.dock.tabs.some(tab => tab.active && tab.id === node.dataset.tab);
			node.classList.toggle("active", active);
			node.setAttribute("aria-selected", String(active));
			node.tabIndex = active ? 0 : -1;
			if (active) {
				elements.dockBody.setAttribute("aria-labelledby", node.id);
				if (selectionChanged || tabsChanged) node.scrollIntoView({ block: "nearest", inline: "nearest" });
			}
		}
		elements.dockBody.setAttribute("role", "tabpanel");
		const panel = view.dock.panel;
		const onlyGroup = panel.groups.length === 1 ? panel.groups[0] : undefined;
		replacePanel(elements.dockBody, onlyGroup?.title === panel.title
			? { ...panel, actions: onlyGroup.actions, groups: [{ ...onlyGroup, title: "", actions: undefined }] }
			: panel);
		positionSessionMenu();
	};

	/** The header's run controls: one icon per action the view offers, each named on its title and in its label. */
	const renderRunActions = (view: WebView): void => {
		const compact = panelButton(view.run.compact, report);
		compact.className = "header-action";
		compact.dataset.action = COMPACT_ACTION;
		placeHeaderAction(compact, view.run.compact.label, "minimize");
		const fork = panelButton(view.run.fork, report);
		fork.className = "header-action";
		fork.dataset.action = "conversation:fork";
		placeHeaderAction(fork, view.run.fork.label, "git-fork");
		const dock = button(view.dock.toggle.pressed ? "header-action pressed" : "header-action");
		dock.dataset.action = DOCK_TOGGLE_ACTION;
		dock.setAttribute("aria-pressed", String(view.dock.toggle.pressed));
		dock.setAttribute("aria-expanded", String(view.dock.toggle.pressed));
		dock.setAttribute("aria-controls", elements.dock.id);
		placeHeaderAction(dock, view.dock.toggle.label, "panel-right");
		dock.addEventListener("click", () => report({ kind: "command", id: DOCK_TOGGLE_ACTION, data: undefined }));
		elements.runActions.replaceChildren(compact, fork, dock);
		elements.laneStatus.textContent = view.lane;
		elements.laneStatus.hidden = view.panel.current !== CHAT_VIEW || view.lane.length === 0;
		if (view.lane.length === 0) elements.laneStatus.removeAttribute("title");
		else elements.laneStatus.title = view.lane;
	};

	/** The composer's submit mode, offered only while a turn runs and can take input. */
	const renderSubmitModes = (view: WebView): void => {
		if (!view.busy) {
			elements.submitModes.replaceChildren();
			elements.submitModes.hidden = true;
			return;
		}
		let select = elements.submitModes.querySelector("select");
		const labelsChanged = changed("submit-mode-labels", [view.locale, view.run.submitModes.map(option => [option.mode, option.label])]);
		if (!select) {
			select = document.createElement("select");
			select.className = "composer-select";
			select.addEventListener("change", () => report({ kind: "command", id: SUBMIT_MODE_ACTION, data: select?.value }));
			elements.submitModes.replaceChildren(select);
		}
		if (labelsChanged || select.options.length === 0) {
			select.replaceChildren(...view.run.submitModes.map(option => {
				const node = document.createElement("option");
				node.value = option.mode;
				node.textContent = option.label;
				return node;
			}));
		}
		select.setAttribute("aria-label", copy("composer.modesAria"));
		select.value = view.run.submitModes.find(option => option.selected)?.mode ?? "";
		select.title = copy(select.value === "steer" ? "composer.steerHelp" : "composer.queueHelp");
		elements.submitModes.hidden = false;
	};

	/** A flow notice (compaction, new context): a labelled rule, with its summary beneath it. */
	const noticeElement = (block: TranscriptBlock): HTMLElement => {
		const group = element("div", "notice");
		group.append(element("p", "notice-rule", block.title));
		if (block.text.length > 0) group.append(element("div", "notice-body", block.text));
		return group;
	};

	/** A failed turn: an alert mark, the failure's title, and its message. */
	const errorElement = (block: TranscriptBlock): HTMLElement => {
		const line = element("div", "error-row");
		const body = element("div", "error-copy");
		body.append(element("span", "error-title", block.title), element("span", "error-message", errorMessageCopy(lastView?.locale ?? FALLBACK_LOCALE, block.text)));
		line.append(icon("alert", "icon error-icon"), body);
		return line;
	};

	/** The live status line, the flow's last item while a turn runs: a pulsing dot and the status. */
	const runningElement = (status: string): HTMLElement => {
		const line = element("div", "running");
		const dot = element("span", "running-dot");
		dot.setAttribute("aria-hidden", "true");
		line.append(dot, element("span", "running-text", status));
		return line;
	};

	const visibleSuggestion = (): WebView["suggestion"] => {
		const view = lastView;
		return view?.suggestion !== undefined && view.suggestion.key !== dismissedSuggestion && !composing && !view.busy &&
			view.attachedId !== undefined && !view.readOnly && view.panel.current === CHAT_VIEW && !view.panel.modal &&
			!view.palette.open && view.approvals.length === 0 && view.queue.length === 0 && view.attachments.length === 0 && elements.prompt.value.length === 0
			? view.suggestion : undefined;
	};
	const renderSuggestion = (): void => {
		const candidate = visibleSuggestion();
		suggestion.hidden = candidate === undefined;
		suggestionPreview.hidden = candidate === undefined || expandedSuggestionKey !== candidate.key;
		previewSuggestion.setAttribute("aria-expanded", String(!suggestionPreview.hidden));
		elements.prompt.setAttribute("aria-label", copy("composer.promptLabel"));
		elements.prompt.placeholder = candidate ? "" : lastView?.sessionDraft !== undefined
			? copy("composer.placeholderDraft") : composerPlaceholder(lastView?.locale ?? FALLBACK_LOCALE, !elements.prompt.disabled);
		if (!candidate) { elements.prompt.removeAttribute("aria-describedby"); return; }
		suggestion.querySelector<HTMLElement>(".suggestion-text")!.textContent = candidate.text;
		acceptSuggestion.querySelector<HTMLElement>("kbd")!.textContent = copy("composer.tabAccept");
		previewSuggestion.title = copy("composer.previewSuggestion");
		previewSuggestion.setAttribute("aria-label", previewSuggestion.title);
		suggestionPreview.setAttribute("aria-label", previewSuggestion.title);
		if (suggestionPreview.textContent !== candidate.text) suggestionPreview.textContent = candidate.text;
		acceptSuggestion.title = copy("composer.acceptSuggestion");
		acceptSuggestion.setAttribute("aria-label", `${copy("composer.acceptSuggestion")}: ${candidate.text}`);
		dismissSuggestion.title = copy("composer.dismissSuggestion");
		dismissSuggestion.setAttribute("aria-label", dismissSuggestion.title);
		pick("suggestion-hint").textContent = `${candidate.text} ${copy("composer.suggestionHint")}`;
		elements.prompt.setAttribute("aria-describedby", "suggestion-hint");
	};
	const takeSuggestion = (): void => {
		const candidate = visibleSuggestion();
		if (!candidate) return;
		dismissedSuggestion = candidate.key;
		renderer.onDismissSuggestion();
		renderer.setDraft(candidate.text);
		elements.prompt.setSelectionRange(candidate.text.length, candidate.text.length);
	};
	const hideSuggestion = (): void => {
		const candidate = visibleSuggestion();
		if (!candidate) return;
		dismissedSuggestion = candidate.key;
		renderer.onDismissSuggestion();
		renderSuggestion();
		elements.prompt.focus({ preventScroll: true });
	};

	/** The group shell survives stream updates; only the reader chooses whether to open it. */
	const processElement = (group: ProcessGroup, area: string, answerId?: string): HTMLElement => {
		const key = `process:${area}:${group.id}`;
		const root = flowCache.get(key, "process-shell", () => {
			const node = element("section", "turn-process");
			const head = element("div", "process-heading");
			const toggle = button("process-toggle");
			const rows = element("div", "process-rows");
			rows.id = `process-rows-${area}-${encodeURIComponent(group.id)}`;
			rows.hidden = true;
			toggle.setAttribute("aria-controls", rows.id);
			toggle.setAttribute("aria-expanded", "false");
			toggle.append(icon("chevron-down", "icon process-chevron"), element("span", "process-title"), element("span", "process-meta"));
			const jump = button("process-jump");
			jump.addEventListener("click", () => {
				const answer = [...elements.column.querySelectorAll<HTMLElement>(".turn-response")].find(item => item.dataset.flowKey === `block:${node.dataset.answerId}`);
				if (!answer) return;
				answer.tabIndex = -1;
				answer.focus({ preventScroll: true });
				answer.scrollIntoView({ block: "start" });
			});
			toggle.addEventListener("click", () => {
				const restore = transcriptPosition(elements.column, elements.transcript, false);
				rows.hidden = !rows.hidden;
				toggle.setAttribute("aria-expanded", String(!rows.hidden));
				node.dataset.open = String(!rows.hidden);
				restore();
				syncTranscriptLatest();
			});
			const failures = button("process-failures");
			failures.setAttribute("aria-controls", rows.id);
			failures.addEventListener("click", () => {
				rows.hidden = false;
				toggle.setAttribute("aria-expanded", "true");
				node.dataset.open = "true";
				const id = node.dataset.firstFailure;
				const row = [...rows.querySelectorAll<HTMLDetailsElement>("details")].find(item => item.dataset.blockId === id);
				if (row && id !== undefined) {
					expanded.set(id, true);
					row.open = true;
					row.querySelector("summary")?.focus({ preventScroll: true });
					row.scrollIntoView({ block: "nearest" });
				}
			});
			head.append(toggle, failures, jump);
			node.append(head, element("p", "process-activity"), element("p", "process-alert"), rows);
			return node;
		});
		root.dataset.state = group.state;
		root.querySelector<HTMLElement>(".process-title")!.textContent = copy("process.title");
		const counts = [
			copy(`process.${group.state}`),
			group.tools > 0 ? copy("process.tools", { count: String(group.tools) }) : "",
			group.thoughts > 0 ? copy("process.thoughts", { count: String(group.thoughts) }) : "",
		].filter(Boolean);
		root.querySelector<HTMLElement>(".process-meta")!.textContent = counts.join(" · ");
		const activity = root.querySelector<HTMLElement>(".process-activity")!;
		activity.hidden = group.state !== "running";
		activity.textContent = group.activity === undefined ? "" : [group.activity.title, group.activity.toolArgs?.collapsed].filter(Boolean).join(" · ");
		const alert = root.querySelector<HTMLElement>(".process-alert")!;
		const firstFailure = group.failures[0];
		const failures = root.querySelector<HTMLButtonElement>(".process-failures")!;
		failures.hidden = firstFailure === undefined;
		failures.textContent = copy("process.failures", { count: String(group.failures.length) });
		failures.setAttribute("aria-label", `${failures.textContent} · ${copy("process.jumpFailure")}`);
		failures.title = firstFailure === undefined ? "" : `${copy("process.failureHint")}\n${firstLine(firstFailure.result?.diagnostics.find(item => item.tone === "error")?.text || firstFailure.text)}`;
		if (firstFailure === undefined) delete root.dataset.firstFailure;
		else root.dataset.firstFailure = String(firstFailure.id);
		alert.hidden = group.state !== "interrupted";
		alert.textContent = copy("process.incomplete");
		const jump = root.querySelector<HTMLButtonElement>(".process-jump")!;
		jump.hidden = answerId === undefined;
		jump.textContent = copy("process.jumpAnswer");
		if (answerId === undefined) delete root.dataset.answerId;
		else root.dataset.answerId = answerId;
		const rows = group.blocks.map(block => flowCache.get(`block:${block.id}`, [lastView?.locale, block], () => block.kind === "tool" ? toolElement(block) : reasoningElement(block)));
		reconcileChildren(root.querySelector<HTMLElement>(".process-rows")!, rows);
		return root;
	};

	/** The flow keeps message and notice boundaries; process rows remain chronological. */
	const flowElements = (blocks: readonly TranscriptBlock[], area: string): HTMLElement[] => {
		const flow: HTMLElement[] = [];
		const items = processGroups(blocks, area === "current" && lastView?.busy === true);
		for (const [index, item] of items.entries()) {
			if (item.kind === "process") {
				const next = items[index + 1];
				flow.push(processElement(item, area, next?.kind === "block" && next.block.kind === "assistant" ? String(next.block.id) : undefined));
				continue;
			}
			const block = item.block;
			const key = `block:${block.id}`;
			if (block.kind === "user") flow.push(flowCache.get(key, [lastView?.locale, block], () => {
				const turn = wrap("turn-user", userBubble(block));
				turn.dataset.blockId = String(block.id);
				if (block.text.length > 0) turn.append(answerActions(block));
				return turn;
			}));
			else if (block.kind === "assistant") {
				const answer = flowCache.get(key, [lastView?.locale, block], () => {
					const answer = wrap("turn-response", markdownElement(block.text, markdownFor(String(block.id))));
					answer.dataset.blockId = String(block.id);
					answer.append(answerActions(block));
					return answer;
				});
				flow.push(answer);
			} else if (block.kind === "notice") flow.push(flowCache.get(key, [lastView?.locale, block], () => {
				const notice = block.tone === "error" ? errorElement(block) : noticeElement(block);
				notice.dataset.blockId = String(block.id);
				return notice;
			}));
		}
		return flow;
	};

	/** Retain the native controls during state updates so keyboard focus survives. */
	const renderComposerContext = (view: WebView): void => {
		elements.composerContext.replaceChildren();
		const context = view.sessionDraft;
		elements.composerContext.hidden = context === undefined;
		if (context === undefined) return;
		const trigger = button("composer-project");
		trigger.disabled = context.disabled;
		trigger.setAttribute("aria-haspopup", "dialog");
		trigger.setAttribute("aria-expanded", "false");
		trigger.setAttribute("aria-label", `${copy("project.choose")}: ${context.label}`);
		trigger.append(icon(context.projectId === null ? "x" : "folder"), element("span", "", context.label));
		const menu = document.createElement("dialog");
		menu.className = "project-picker";
		menu.setAttribute("aria-label", copy("project.choose"));
		const search = document.createElement("input");
		search.type = "search"; search.placeholder = copy("project.search"); search.setAttribute("aria-label", search.placeholder);
		const rows = element("div", "project-picker-list");
		const option = (label: string, glyph: IconName, selected: boolean, choose: () => void): HTMLButtonElement => {
			const control = button("project-picker-option");
			control.setAttribute("aria-pressed", String(selected));
			control.append(icon(glyph), element("span", "", label));
			if (selected) control.append(icon("check"));
			control.addEventListener("click", () => { menu.close(); choose(); });
			return control;
		};
		const fill = (): void => {
			const needle = search.value.trim().toLowerCase();
			const matching = context.projects.filter(project => project.name.toLowerCase().includes(needle));
			rows.replaceChildren(...matching.map(project => option(project.name, "folder", project.id === context.projectId,
				() => report({ kind: "command", id: COMPOSER_PROJECT_ACTION, data: project.id }))));
			if (matching.length === 0) rows.append(element("p", "project-picker-empty", copy("project.noMatch")));
		};
		search.addEventListener("input", fill);
		menu.append(search, rows,
			option(copy("project.add"), "plus", false, () => report({ kind: "command", id: PROJECT_ADD_ACTION, data: undefined })),
			option(copy("project.standalone"), "x", context.projectId === null, () => report({ kind: "command", id: COMPOSER_PROJECT_ACTION, data: undefined })));
		trigger.addEventListener("click", () => {
			fill(); menu.showModal();
			const rect = trigger.getBoundingClientRect();
			menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
			menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 8)}px`;
			trigger.setAttribute("aria-expanded", "true"); search.focus();
		});
		menu.addEventListener("close", () => { trigger.setAttribute("aria-expanded", "false"); trigger.focus(); });
		menu.addEventListener("click", event => { if (event.target === menu) menu.close(); });
		menu.addEventListener("keydown", event => {
			if (event.key === "Escape") { event.preventDefault(); menu.close(); return; }
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			event.preventDefault();
			const options = [...menu.querySelectorAll<HTMLButtonElement>(".project-picker-option")];
			const index = options.findIndex(option => option === document.activeElement);
			const next = index < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1)
				: (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
			options[next]?.focus();
		});
		elements.composerContext.append(trigger, menu);
	};

	const renderModelSelectors = (view: WebView): void => {
		const picker = view.model;
		const options = picker.groups.flatMap(group => group.options);
		if (changed("model-options", [view.locale, picker.groups.map(group => [group.provider, group.options.map(option => [option.modelId, option.label])]), picker.empty, picker.scopeNotice, view.sessionDraft !== undefined])) {
			const placeholder = document.createElement("option");
			placeholder.value = "";
			placeholder.disabled = true;
			const scopeEmpty = picker.empty === copy("model.scopeEmpty");
			placeholder.textContent = picker.empty === undefined ? copy("model.choose") : scopeEmpty ? copy("model.configure") : copy("model.connectProvider");
			elements.modelSelect.replaceChildren(placeholder);
			for (const group of picker.groups) {
				const optgroup = document.createElement("optgroup");
				optgroup.label = group.provider;
				for (const option of group.options) {
					const node = document.createElement("option");
					node.value = JSON.stringify([option.provider, option.modelId]);
					node.textContent = option.label;
					optgroup.append(node);
				}
				elements.modelSelect.append(optgroup);
			}
		}
		const selected = options.find(option => option.selected);
		const showSetup = options.length === 0 && picker.empty !== undefined;
		elements.modelSelect.hidden = showSetup;
		modelSetup.hidden = !showSetup;
		if (showSetup) {
			if (changed("model-setup", [view.locale, picker.empty, picker.disabled, view.modelPending])) {
				const scopeEmpty = picker.empty === copy("model.scopeEmpty");
				const makeAction = (id: string, label: string, primary: boolean): HTMLButtonElement => {
					const node = button(primary ? "model-setup-button weight-filled" : "model-setup-button weight-line");
					node.dataset.action = id;
					node.textContent = label;
					node.title = [label, picker.empty].filter(Boolean).join("\n");
					node.disabled = picker.disabled;
					node.setAttribute("aria-busy", String(view.modelPending === true));
					node.addEventListener("click", () => triggerModelSetup(id));
					return node;
				};
				modelSetup.replaceChildren(
					...(scopeEmpty
						? [
								makeAction(MODEL_SCOPE_ACTION, copy("model.configureModels"), true),
								makeAction(MODEL_CONNECTIONS_ACTION, copy("model.connectProvider"), false),
							]
						: [makeAction(MODEL_CONNECTIONS_ACTION, copy("model.connectProvider"), true)]),
				);
			}
		} else {
			chromeValues.delete("model-setup");
			modelSetup.replaceChildren();
		}
		elements.modelSelect.value = selected ? JSON.stringify([selected.provider, selected.modelId]) : "";
		elements.modelSelect.disabled = picker.disabled || options.length === 0;
		elements.modelSelect.setAttribute("aria-busy", String(view.modelPending === true));
		elements.modelSelect.title = [picker.label, picker.scopeNotice, picker.empty, picker.refresh.status, copy("model.nextRequest")].filter(Boolean).join("\n");
		if (changed("thinking-options", [view.locale, picker.levels.map(level => [level.level, level.label])])) {
			elements.thinkingSelect.replaceChildren(...picker.levels.map(level => {
				const option = document.createElement("option");
				option.value = level.level;
				option.textContent = level.label;
				return option;
			}));
		}
		elements.thinkingSelect.value = picker.levels.find(level => level.selected)?.level ?? "";
		elements.thinkingSelect.hidden = picker.levels.length <= 1;
		elements.thinkingSelect.disabled = picker.disabled || picker.levels.length <= 1;
		elements.thinkingSelect.title = [picker.effort, picker.levelsEmpty ?? copy("model.nextRequest")].filter(Boolean).join("\n");
		// Preserve the exported native-control adapters for embedders; the shared menu owns presentation.
		elements.modelSelect.hidden = true;
		elements.thinkingSelect.hidden = true;
		modelSetup.hidden = true;
		sharedModelPicker.update(view.locale, picker, view.sessionDraft?.disabled);
	};

	const syncTranscriptLatest = (): void => {
		const view = lastView;
		const hasConversation = view !== undefined && (view.blocks.length > 0 || view.history.blocks.length > 0);
		if (view === undefined || view.panel.current !== CHAT_VIEW || elements.transcript.hidden || !hasConversation) {
			transcriptLatest.hidden = true;
			return;
		}
		if (atBottom(elements.transcript)) {
			unreadTranscriptBelow = false;
			seenTranscriptDigest = transcriptDigest(view);
			transcriptLatest.hidden = true;
			delete transcriptLatest.dataset.unread;
			return;
		}
		const label = copy(unreadTranscriptBelow ? "transcript.newContent" : "transcript.jumpLatest");
		transcriptLatest.hidden = false;
		if (unreadTranscriptBelow) transcriptLatest.dataset.unread = "true";
		else delete transcriptLatest.dataset.unread;
		if (changed("transcript-latest", [view.locale, unreadTranscriptBelow])) {
			const children: Node[] = [];
			if (unreadTranscriptBelow) {
				const dot = element("span", "running-dot latest-dot");
				dot.setAttribute("aria-hidden", "true");
				children.push(dot);
			}
			children.push(element("span", "transcript-latest-label", label), icon("chevron-down", "icon transcript-latest-icon"));
			transcriptLatest.replaceChildren(...children);
			transcriptLatest.title = label;
			transcriptLatest.setAttribute("aria-label", label);
		}
	};


	let rescanTranscriptSearch: (loadHistory: boolean) => void = () => {};
	const renderer: PageRenderer = {
		onSelect,
		onCreateSession: () => {},
		onSubmit: () => {},
		onAbort: () => {},
		onSelectModel: () => {},
		onSelectThinking: () => {},
		onAttachFiles: () => {},
		onFilterRoster: () => {},
		onShortcut: () => {},
		onPaletteSelection: () => {},
		onDraftChange: () => {},
		onDismissSuggestion: () => {},
		onCommandPick: () => {},
		onPanelAction: () => {},
		refreshTranscriptSearch(options): void {
			rescanTranscriptSearch(options?.loadHistory === true);
		},
		get view(): WebView | undefined {
			return lastView;
		},
		render(view: WebView): void {
			if (changed("typography", view.typography)) applyTypography(document.documentElement.style, view.typography);
			if (view.panel.modal !== undefined && elements.modalRoot.hidden) captureModalFocus();
			const languageChanged = lastView?.locale !== view.locale;
			const sessionChanged = lastView?.attachedId !== view.attachedId;
			if (sessionChanged) {
				drafts.clear();
				hideQuoteAction();
			}
			if (view.panel.current !== CHAT_VIEW || view.readOnly === true || view.attachedId === undefined) hideQuoteAction();
			if (
				lastView?.panel.current === CHAT_VIEW &&
				view.panel.current === SETTINGS_VIEW &&
				view.attachedId !== undefined &&
				view.readOnly !== true &&
				(lastView.model.empty !== undefined || elements.prompt.value.length > 0)
			) {
				modelSetupReturn ??= {
					scope: attachmentScope(view),
					...promptSelection,
				};
			}
			lastView = view;
			const preview = attachmentPreview;
			if (preview !== undefined && (attachmentScope(view) !== preview.scope || view.panel.current !== CHAT_VIEW ||
				!view.attachments.some(attachment => attachment.id === preview.attachmentId))) closeAttachmentPreview();
			if (languageChanged) renderShellCopy();
			elements.newChat.replaceChildren(icon("square-pen"), document.createTextNode(copy("sidebar.newChat")));
			elements.newChat.disabled = !view.newSession.enabled;
			if (changed("composer-context", [view.locale, view.sessionDraft])) renderComposerContext(view);
			elements.sessionWarning.hidden = view.mirrorWarning == null;
			elements.sessionWarning.textContent = view.mirrorWarning == null ? "" : copy("page.mirrorWarning", view.mirrorWarning);
			if (app !== undefined) writeWindowTitle(app, { ...view, sessionLabel: view.panel.panel?.title ?? view.sessionLabel });
			const transcriptVisible = !elements.transcript.hidden;
			const stick = atBottom(elements.transcript);
			const scopeChanged = flowCache.begin(view.transcriptScope ?? view.attachedId ?? "");
			const restorePosition = scopeChanged || !transcriptVisible
				? () => {
					elements.transcript.scrollTop = elements.transcript.scrollHeight;
				}
				: transcriptPosition(elements.column, elements.transcript, stick);
			if (scopeChanged) {
				restoreChatPosition = undefined;
				expanded.clear();
				reading.clear();
				expandedSuggestionKey = undefined;
				chromeValues.clear();
				elements.column.replaceChildren();
				heldPromptFocus = undefined;
				modelSetupReturn = undefined;
				seenTranscriptDigest = transcriptDigest(view);
				unreadTranscriptBelow = false;
				setMeterExpanded(false);
			}

			// Streaming repaints keep the roster's nodes and keyboard focus when it has not changed.
			const nextRosterKey = JSON.stringify([view.locale, view.roster, view.projects, view.archivedAttached, view.empty, view.newSession]);
			if (rosterKey !== nextRosterKey) {
				rosterKey = nextRosterKey;
				const focused = document.activeElement;
				const focusedRow = focused instanceof HTMLElement ? focused.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId : undefined;
				const focusedMore = focused instanceof HTMLElement && focused.classList.contains("session-more");
				elements.roster.replaceChildren();
				const heading = elements.sidebar.querySelector(".sidebar-label");
				if (heading) {
					heading.replaceChildren(document.createTextNode(copy(view.projects === undefined ? "sidebar.sessions" : "project.projects")));
					if (view.projects !== undefined) {
						const add = button("project-add"); add.id = "project-add"; add.title = copy("project.add"); add.setAttribute("aria-label", add.title); add.append(icon("plus"));
						add.addEventListener("click", () => report({ kind: "command", id: PROJECT_ADD_ACTION, data: undefined })); heading.append(add);
					}
				}
				if (view.projects !== undefined) {
					for (const group of view.projects) {
						const section = element("div", "project-group");
						const projectId = group.id;
						section.dataset.projectId = projectId;
						const head = element("div", "project-heading");
						const select = button(group.selected ? "project-select selected" : "project-select"); select.title = (group.workspaces ?? [group.cwd]).join("\n");
						select.setAttribute("aria-expanded", String(group.expanded));
						select.append(icon("folder"), element("span", "project-name", group.name));
						select.addEventListener("click", () => report({ kind: "command", id: PROJECT_SELECT_ACTION, data: projectId })); head.append(select);
						const more = button("project-action project-more"); more.title = copy("project.actions"); more.setAttribute("aria-label", `${more.title}: ${group.name}`);
						more.dataset.menuId = `project:${projectId}`; more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false"); more.append(icon("more"));
						more.addEventListener("click", () => openRosterMenu(`project:${projectId}`, projectId, copy("project.actions"), [
							{ id: PROJECT_EDIT_ACTION, label: copy("project.edit"), glyph: "square-pen" },
							{ id: PROJECT_REMOVE_ACTION, label: copy("project.remove"), glyph: "x", danger: true },
						]));
						head.append(more);
						const creating = view.newSession.pending === true;
						const newLabel = copy(creating ? "sidebar.creating" : "sidebar.newSession");
						const create = button("project-action project-new-session");
						create.disabled = !view.newSession.enabled;
						create.title = newLabel;
						create.setAttribute("aria-label", `${newLabel}: ${group.name}`);
						create.setAttribute("aria-busy", String(creating));
						create.append(icon("square-pen"));
						create.addEventListener("click", () => report({ kind: "command", id: PROJECT_NEW_SESSION_ACTION, data: projectId })); head.append(create);
						section.append(head);
						if (group.expanded) {
							const items = element("div", "project-sessions");
							for (const item of group.items) items.append(sessionRow(item));
							if (group.items.length === 0) items.append(element("p", "empty-state", view.empty ?? copy("project.empty")));
							section.append(items);
						}
						elements.roster.append(section);
					}
					const grouped = new Set(view.projects.flatMap(group => group.items.map(item => item.id)));
					const standalone = view.roster.filter(item => !grouped.has(item.id));
					if (standalone.length > 0) {
						elements.roster.append(element("p", "session-group-label", copy("sidebar.chats")));
						for (const item of standalone) elements.roster.append(sessionRow(item));
					}
				} else for (const group of rosterGroups(view.locale, view.roster)) {
					const section = element("div", "session-group");
					section.append(element("p", "session-group-label", group.label));
					for (const item of group.items) section.append(sessionRow(item));
					elements.roster.append(section);
				}
				if (view.archivedAttached !== undefined) {
					const section = element("div", "project-group archived");
					const head = element("div", "project-heading");
					const title = element("div", "project-archived-title");
					title.append(icon("folder"), element("span", "project-name", copy("project.archived")));
					head.append(title);
					section.append(head);
					const items = element("div", "project-sessions");
					items.append(sessionRow(view.archivedAttached));
					section.append(items);
					elements.roster.append(section);
				}
				if (view.roster.length === 0 && !view.projects?.some(group => group.expanded && group.items.length === 0) && (view.empty !== undefined || view.projects === undefined || view.projects.length === 0)) {
					const empty = element("p", "empty-state", view.empty ?? copy("header.rosterEmpty"));
					empty.id = "roster-empty";
					elements.roster.append(empty);
				}
				if (focusedRow !== undefined) {
					const trigger = sessionMenuTrigger(focusedRow);
					(focusedMore ? trigger : trigger?.parentElement?.querySelector<HTMLButtonElement>(".session-select"))?.focus();
				}
				positionSessionMenu();
			}
			if (document.activeElement !== elements.rosterFilter) {
				elements.rosterFilter.value = view.rosterFilter;
				if (view.rosterFilter.length === 0) setRosterFilterOpen(false);
			}
			if (view.rosterFilter.length > 0) setRosterFilterOpen(true);

			const flow = flowElements(view.blocks, "current");
			const hasConversation = view.blocks.length > 0 || view.history.blocks.length > 0;
			// The pages the reader asked for sit above the live transcript, in their own group.
			if (view.history.blocks.length > 0) {
				const pages = flowCache.get("history", "history-pages", () => element("div", "history-pages"));
				reconcileChildren(pages, flowElements(view.history.blocks, "history"));
				flow.unshift(pages);
			}
			// "Load older" belongs to a conversation that has entries; an empty one has nothing to load.
			if (hasConversation && (view.history.loading || view.history.more)) {
				const more = flowCache.get("history-more", [view.locale, view.history.loading, view.attachedId !== undefined], () => {
					const more = element("div", "history-more");
					const control = button(view.history.loading ? "history-more-button loading" : "history-more-button");
					control.dataset.action = HISTORY_MORE_ACTION;
					control.disabled = view.history.loading || view.attachedId === undefined;
					control.textContent = copy(view.history.loading ? "history.loading" : "history.more");
					control.addEventListener("click", () => report({ kind: "command", id: HISTORY_MORE_ACTION, data: undefined }));
					more.append(control);
					return more;
				});
				flow.unshift(more);
			}
			// The empty layout centres the greeting and the composer; anything in the transcript brings the conversation layout.
			elements.center.dataset.state = hasConversation || view.status.length > 0 ? "chat" : "empty";
			elements.center.dataset.attached = String(view.attachedId !== undefined);
			elements.center.dataset.draft = String(view.sessionDraft !== undefined);
			elements.center.dataset.readOnly = String(view.readOnly === true);
			if (view.blocks.length === 0) {
				flow.push(flowCache.get("empty", [view.locale, view.welcome, view.attachedId, view.roster.length, view.rosterFilter, view.newSession, view.sessionDraft, view.readOnly, view.archivedAttached, view.model.empty, view.model.disabled], () => view.welcome !== undefined ? welcomeElement(view, view.welcome) : emptyElement(view)));
			}
			if (view.status.length > 0) flow.push(flowCache.get("status", view.status, () => runningElement(view.status)));
			reconcileChildren(elements.column, flow);
			flowCache.finish();

			const detached = !canCompose(view);
			if (!scopeChanged && detached && !elements.prompt.disabled && document.activeElement === elements.prompt) {
				heldPromptFocus = {
					start: elements.prompt.selectionStart,
					end: elements.prompt.selectionEnd,
					direction: elements.prompt.selectionDirection,
				};
			}
			elements.prompt.disabled = detached;
			if (!detached && heldPromptFocus !== undefined) {
				if (document.activeElement === document.body || document.activeElement === elements.prompt) {
					elements.prompt.focus({ preventScroll: true });
					elements.prompt.setSelectionRange(heldPromptFocus.start, heldPromptFocus.end, heldPromptFocus.direction);
				}
				heldPromptFocus = undefined;
			}
			renderSuggestion();
			renderPrimary();
			renderStop();
			renderApprovalStatus(view);
			renderMeter(view);

			if (changed("queue", [view.locale, view.queue])) {
				elements.queue.replaceChildren();
				for (const item of view.queue) elements.queue.append(queueElement(item));
			}

			if (changed("model", [view.locale, view.model, view.sessionDraft !== undefined])) renderModelSelectors(view);
			if (changed("attachments", view.attachments)) renderAttachments(view);
			const paletteChanged = changed("palette", [view.locale, view.palette, view.attachedId !== undefined]);
			if (paletteChanged) renderPalette(view);
			if (changed("approvals", [view.locale, view.approvals])) renderApprovals(view);
			if (changed("run", [view.locale, view.run, view.dock.toggle, view.lane, view.panel.current])) renderRunActions(view);
			if (changed("dock", [view.locale, view.dock, view.panel.current])) renderDock(view);
			if (changed("submit", [view.locale, view.busy, view.run.submitModes])) renderSubmitModes(view);
			if (changed("nav", [view.locale, view.panel.nav, view.panel.current])) renderNav(view);
			if (changed("panel", [view.locale, view.panel.panel, view.sessionLabel, view.focus, view.modelConnections])) renderPanelView(view);
			syncLibraryChrome(view);
			renderModal(view.panel.modal);
			if (
				modelSetupReturn !== undefined &&
				view.panel.current === CHAT_VIEW &&
				view.panel.modal === undefined &&
				!detached
			) {
				const returned = modelSetupReturn;
				modelSetupReturn = undefined;
				if (attachmentScope(view) === returned.scope) {
					const start = Math.min(returned.start, elements.prompt.value.length);
					const end = Math.min(returned.end, elements.prompt.value.length);
					elements.prompt.focus({ preventScroll: true });
					elements.prompt.setSelectionRange(start, end, returned.direction);
					rememberPromptSelection();
				}
			}
			// The composer's dock may have grown (an approval, a queued input) and shrunk the transcript
			// under the reader; a reader who was at the bottom stays there.
			if (view.panel.current === CHAT_VIEW) {
				(restoreChatPosition ?? restorePosition)();
				restoreChatPosition = undefined;
				const nextDigest = transcriptDigest(view);
				if (atBottom(elements.transcript)) {
					seenTranscriptDigest = nextDigest;
					unreadTranscriptBelow = false;
				} else if (seenTranscriptDigest !== "" && nextDigest !== seenTranscriptDigest) {
					unreadTranscriptBelow = true;
				} else if (seenTranscriptDigest === "") {
					seenTranscriptDigest = nextDigest;
				}
				syncTranscriptLatest();
				// The palette shares the scroll area with approvals and queued inputs. Its keyboard
				// selection must remain visible after those preceding cards have been painted.
				if (paletteChanged && view.palette.open) elements.palette.querySelector<HTMLElement>(".palette-row.selected")?.scrollIntoView({ block: "nearest" });
			} else if (transcriptVisible) {
				restoreChatPosition = restorePosition;
				syncTranscriptLatest();
			} else {
				syncTranscriptLatest();
			}
		},
		setDraft(text: string, focus = true): void {
			if (elements.prompt.value !== text) elements.prompt.value = text;
			promptSelection = { start: text.length, end: text.length, direction: "none" };
			fitPrompt(elements.prompt);
			renderPrimary();
			renderer.onDraftChange(text);
			renderSuggestion();
			if (focus) elements.prompt.focus();
		},
		insertDraft(text: string, focus = true): void {
			const prompt = elements.prompt;
			const inserted = insertDraftText(prompt.value, promptSelection.start, promptSelection.end, text);
			prompt.value = inserted.text;
			promptSelection = { start: inserted.cursor, end: inserted.cursor, direction: "none" };
			fitPrompt(prompt);
			renderPrimary();
			renderer.onDraftChange(inserted.text);
			renderSuggestion();
			if (focus) {
				prompt.focus();
				prompt.setSelectionRange(inserted.cursor, inserted.cursor);
			}
		},
		setConnection(text: ConnectionText, kind: "state" | "error", label?: ConnectionText): void {
			connectionCopy = { text, kind, ...(label === undefined ? {} : { label }) };
			renderConnection();
		},
		setConnectionState(text: ConnectionText, state: ConnectionState): void {
			connectionStateCopy = { text, state };
			connectionCopy = undefined;
			renderConnection();
		},
	};

	syncSidebarToggle();
	elements.transcript.addEventListener("scroll", () => syncTranscriptLatest());
	transcriptLatest.addEventListener("click", () => {
		elements.transcript.scrollTop = elements.transcript.scrollHeight;
		unreadTranscriptBelow = false;
		if (lastView !== undefined) seenTranscriptDigest = transcriptDigest(lastView);
		syncTranscriptLatest();
	});
	document.addEventListener("pointerdown", (event) => {
		if (event.target !== elements.prompt) heldPromptFocus = undefined;
		else modelSetupReturn = undefined;
	});

	elements.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!canCompose(lastView)) return;
		const text = draft();
		if (text.startsWith("/") && lastView?.palette.open === true) {
			const selected = lastView.palette.rows.find((row) => row.selected);
			const line = lastView.commandLine;
			// A bare `/name` completes to the highlighted command; a full line runs as typed.
			if (!line && selected !== undefined) {
				renderer.onCommandPick(selected.value);
				return;
			}
		}
		if (text.length === 0 && (lastView?.attachments.length ?? 0) === 0) return;
		elements.prompt.value = "";
		fitPrompt(elements.prompt);
		renderPrimary();
		renderer.onDraftChange("");
		renderer.onSubmit(text);
	});
	acceptSuggestion.addEventListener("click", takeSuggestion);
	dismissSuggestion.addEventListener("click", hideSuggestion);
	previewSuggestion.addEventListener("click", () => {
		const candidate = visibleSuggestion();
		if (!candidate) return;
		expandedSuggestionKey = expandedSuggestionKey === candidate.key ? undefined : candidate.key;
		renderSuggestion();
		if (!suggestionPreview.hidden) suggestionPreview.focus({ preventScroll: true });
	});
	elements.prompt.addEventListener("compositionstart", () => { composing = true; renderSuggestion(); });
	elements.prompt.addEventListener("compositionend", () => { composing = false; renderSuggestion(); });
	elements.prompt.addEventListener("input", () => {
		modelSetupReturn = undefined;
		rememberPromptSelection();
		fitPrompt(elements.prompt);
		// An empty draft disables send. The text decides whether the command palette is open.
		renderPrimary();
		renderer.onDraftChange(elements.prompt.value);
		renderSuggestion();
	});
	for (const eventName of ["keyup", "click", "select", "focus"] as const) {
		elements.prompt.addEventListener(eventName, rememberPromptSelection);
	}
	elements.prompt.addEventListener("keydown", (event) => {
		if (composing || event.isComposing || event.keyCode === 229) return;
		const palette = lastView?.palette;
		if (palette?.open === true && palette.rows.length > 0) {
			// The palette owns the arrows, Tab, and a bare `/`'s Enter while it is open.
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				const current = palette.rows.findIndex((row) => row.selected);
				const next = (current + step + palette.rows.length) % palette.rows.length;
				renderer.onPaletteSelection(next);
				return;
			}
			if (event.key === "Tab") {
				event.preventDefault();
				const selected = palette.rows.find((row) => row.selected) ?? palette.rows[0];
				if (selected !== undefined) renderer.onCommandPick(selected.value);
				return;
			}
		}
		if (visibleSuggestion() && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			if (event.key === "Tab" || event.key === "Escape") {
				event.preventDefault(); event.stopPropagation();
				if (event.key === "Tab") takeSuggestion(); else hideSuggestion();
				return;
			}
		}
		// Enter submits, Shift+Enter keeps the newline: the same contract the TUI composer uses.
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		elements.composer.requestSubmit();
	});
	/** The filter occupies the brand row only while it is open or holding a query. */
	const setRosterFilterOpen = (open: boolean): void => {
		elements.rosterFilterField.dataset.open = String(open);
		elements.rosterFilter.hidden = !open;
		elements.rosterFilterToggle.setAttribute("aria-expanded", String(open));
	};
	const openRosterFilter = (): void => {
		setRosterFilterOpen(true);
		elements.rosterFilter.focus();
	};
	elements.rosterFilterToggle.addEventListener("click", () => {
		if (elements.rosterFilter.hidden) openRosterFilter();
		else elements.rosterFilter.focus();
	});
	elements.rosterFilter.addEventListener("input", () => renderer.onFilterRoster(elements.rosterFilter.value));
	elements.rosterFilter.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		if (elements.rosterFilter.value.length > 0) {
			elements.rosterFilter.value = "";
			renderer.onFilterRoster("");
		}
		setRosterFilterOpen(false);
		elements.rosterFilterToggle.focus();
	});
	elements.rosterFilter.addEventListener("focusout", (event) => {
		const next = event.relatedTarget;
		if (next instanceof Node && elements.rosterFilterField.contains(next)) return;
		if (elements.rosterFilter.value.length === 0) setRosterFilterOpen(false);
	});
	const clearSettingsQuery = (): void => {
		settingsQuery = "";
		settingsHighlight = -1;
		elements.sectionSearchInput.value = "";
		elements.sectionSearchClear.hidden = true;
		if (lastView?.panel.current === SETTINGS_VIEW) paintSectionNav(lastView);
	};
	elements.sectionSearchInput.addEventListener("input", () => {
		settingsQuery = elements.sectionSearchInput.value;
		settingsHighlight = -1;
		elements.sectionSearchClear.hidden = settingsQuery.length === 0;
		if (lastView?.panel.current === SETTINGS_VIEW) paintSectionNav(lastView);
	});
	elements.sectionSearchClear.addEventListener("click", () => {
		clearSettingsQuery();
		elements.sectionSearchInput.focus();
	});
	elements.sectionSearchInput.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		if (event.key === "Escape") {
			if (settingsQuery.length === 0) return;
			event.preventDefault();
			event.stopPropagation();
			clearSettingsQuery();
			return;
		}
		if (settingsHits.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const delta = event.key === "ArrowDown" ? 1 : -1;
			settingsHighlight = settingsHighlight < 0 ? (delta > 0 ? 0 : settingsHits.length - 1) : (settingsHighlight + delta + settingsHits.length) % settingsHits.length;
			settingsHighlightFollow = true;
			if (lastView?.panel.panel !== undefined) markSectionNav(sections.get(lastView.panel.panel.id));
			return;
		}
		if (event.key !== "Enter") return;
		event.preventDefault();
		const hit = settingsHits[settingsHighlight] ?? settingsHits[0];
		if (hit !== undefined && lastView?.panel.panel !== undefined) openSection(lastView.panel.panel.id, hit.groupId, hit.rowId);
	});
	// In-conversation search reads mounted block text, including folded tools. A query while
	// older history is still unloaded asks the page to page it in, then searches that text too.
	let transcriptHits: HTMLElement[] = [];
	let transcriptHitIndex = -1;
	let transcriptSearchReturnFocus: HTMLElement | undefined;
	const closeTranscriptSearch = (): void => {
		if (elements.transcriptSearch.hidden) return;
		elements.transcriptSearch.hidden = true;
		elements.transcriptSearchInput.value = "";
		elements.transcriptSearchCount.textContent = "";
		transcriptHits = [];
		transcriptHitIndex = -1;
		for (const marked of elements.transcript.querySelectorAll(".search-hit")) marked.classList.remove("search-hit");
		transcriptSearchReturnFocus?.focus({ preventScroll: true });
	};
	const revealTranscriptHit = (): void => {
		const node = transcriptHits[transcriptHitIndex];
		if (node === undefined) return;
		for (const marked of elements.transcript.querySelectorAll(".search-hit")) marked.classList.remove("search-hit");
		const group = node.closest<HTMLElement>(".turn-process");
		if (group !== null) {
			const rows = group.querySelector<HTMLElement>(".process-rows");
			const toggle = group.querySelector<HTMLElement>(".process-toggle");
			if (rows !== null) rows.hidden = false;
			toggle?.setAttribute("aria-expanded", "true");
			group.dataset.open = "true";
		}
		if (node instanceof HTMLDetailsElement) {
			node.open = true;
			expanded.set(node.dataset.blockId ?? "", true);
		}
		node.classList.add("search-hit");
		node.scrollIntoView({ block: "center" });
	};
	const runTranscriptSearch = (loadHistory = false): void => {
		const query = elements.transcriptSearchInput.value;
		const nodes = [...elements.transcript.querySelectorAll<HTMLElement>("[data-block-id]")];
		const hits = transcriptSearchHits(
			nodes.map((node) => ({ id: node.dataset.blockId ?? "", text: node.textContent ?? "" })),
			query,
		);
		const byId = new Map(nodes.map((node) => [node.dataset.blockId ?? "", node]));
		transcriptHits = hits.flatMap((id) => {
			const node = byId.get(id);
			return node === undefined ? [] : [node];
		});
		transcriptHitIndex = transcriptHits.length === 0 ? -1 : 0;
		elements.transcriptSearchCount.textContent =
			transcriptHits.length === 0
				? query.trim().length === 0
					? ""
					: copy("transcript.searchNone")
				: `${transcriptHitIndex + 1}/${transcriptHits.length}`;
		if (transcriptHitIndex >= 0) revealTranscriptHit();
		if (loadHistory && query.trim().length > 0 && lastView?.history.more === true && lastView.history.loading !== true) {
			report({ kind: "command", id: TRANSCRIPT_SEARCH_ACTION, data: query });
		}
	};
	rescanTranscriptSearch = (loadHistory): void => {
		if (elements.transcriptSearch.hidden) return;
		runTranscriptSearch(loadHistory);
	};
	const stepTranscriptSearch = (delta: number): void => {
		if (transcriptHits.length === 0) return;
		transcriptHitIndex = (transcriptHitIndex + delta + transcriptHits.length) % transcriptHits.length;
		elements.transcriptSearchCount.textContent = `${transcriptHitIndex + 1}/${transcriptHits.length}`;
		revealTranscriptHit();
	};
	const openTranscriptSearch = (): void => {
		if (elements.transcriptSearch.hidden) {
			transcriptSearchReturnFocus =
				document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
			elements.transcriptSearch.hidden = false;
		}
		elements.transcriptSearchInput.focus();
		elements.transcriptSearchInput.select();
	};
	elements.transcriptSearchInput.addEventListener("input", () => runTranscriptSearch(true));
	elements.transcriptSearchInput.addEventListener("keydown", (event) => {
		if (event.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeTranscriptSearch();
			return;
		}
		if (event.key !== "Enter") return;
		event.preventDefault();
		stepTranscriptSearch(event.shiftKey ? -1 : 1);
	});
	elements.transcriptSearchClose.addEventListener("click", closeTranscriptSearch);
	elements.newChat.addEventListener("click", () => renderer.onCreateSession());
	elements.attach.addEventListener("click", () => elements.fileInput.click());
	elements.fileInput.addEventListener("change", () => {
		const files = [...(elements.fileInput.files ?? [])];
		// Clearing lets the same file be picked again after a remove.
		elements.fileInput.value = "";
		if (files.length > 0) renderer.onAttachFiles(files);
	});
	elements.prompt.addEventListener("paste", (event) => {
		const files = [...(event.clipboardData?.files ?? [])];
		if (files.length === 0) return;
		event.preventDefault();
		renderer.onAttachFiles(files);
	});
	elements.composer.addEventListener("dragover", (event) => {
		if (!event.dataTransfer?.types.includes("Files")) return;
		event.preventDefault();
		elements.composer.classList.add("dropping");
	});
	elements.composer.addEventListener("dragleave", () => elements.composer.classList.remove("dropping"));
	elements.composer.addEventListener("drop", (event) => {
		const files = [...(event.dataTransfer?.files ?? [])];
		elements.composer.classList.remove("dropping");
		if (files.length === 0) return;
		event.preventDefault();
		renderer.onAttachFiles(files);
	});
	// Selecting the current destination keeps that page open; the home icon returns to the conversation.
	elements.settingsButton.addEventListener("click", () => {
		report({
			kind: "open",
			panel: SETTINGS_VIEW,
		});
	});
	elements.modalRoot.addEventListener("cancel", (event) => {
		event.preventDefault();
		requestModalClose();
	});
	let backdropPressed = false;
	elements.modalRoot.addEventListener("pointerdown", (event) => {
		backdropPressed = event.target === elements.modalRoot;
	});
	elements.modalRoot.addEventListener("click", (event) => {
		if (backdropPressed && event.target === elements.modalRoot && lastView?.panel.modal?.danger !== true) requestModalClose();
		backdropPressed = false;
	});
	elements.viewBack.addEventListener("click", () => report({ kind: "open", panel: CHAT_VIEW }));
	elements.sidebarToggle.addEventListener("click", toggleSidebar);
	elements.modelSelect.addEventListener("change", () => {
		if (elements.modelSelect.disabled) return;
		const option = lastView?.model.groups.flatMap(group => group.options).find(option => JSON.stringify([option.provider, option.modelId]) === elements.modelSelect.value);
		if (option) renderer.onSelectModel(option.provider, option.modelId);
	});
	elements.thinkingSelect.addEventListener("change", () => {
		if (!elements.thinkingSelect.disabled) renderer.onSelectThinking(elements.thinkingSelect.value);
	});
	// Session menus close when their roster moves.
	elements.roster.addEventListener("scroll", () => closeSessionMenu());
	window.addEventListener("resize", () => {
		closeSessionMenu();
		if (lastView !== undefined) syncLibraryChrome(lastView);
		else syncSidebarToggle();
	});
	meterNodes.trigger.addEventListener("click", () => {
		if (!elements.meter.hidden) setMeterExpanded(!meterExpanded);
	});
	document.addEventListener("pointerdown", (event) => {
		const target = event.target;
		if (sessionMenu !== undefined && target instanceof Node && !sessionMenu.node.contains(target) && !sessionMenuTrigger(sessionMenu.id)?.contains(target)) closeSessionMenu();
		if (meterExpanded && target instanceof Node && !elements.meter.contains(target)) setMeterExpanded(false);
		if (!quoteAction.hidden && target instanceof Node && !quoteAction.contains(target)) hideQuoteAction();
	});
	quoteAction.addEventListener("mousedown", (event) => event.preventDefault());
	quoteAction.addEventListener("click", () => {
		if (quoteDraft === undefined) return;
		const draft = quoteDraft;
		hideQuoteAction();
		document.getSelection()?.removeAllRanges();
		renderer.insertDraft(draft);
	});
	/**
	 * Move to the next or previous question. The transcript's top edge is the
	 * reference, so "previous" is the last question currently above it.
	 */
	const jumpPrompt = (direction: 1 | -1): void => {
		const turns = [...elements.transcript.querySelectorAll<HTMLElement>(".turn-user")];
		if (turns.length === 0) return;
		const top = elements.transcript.getBoundingClientRect().top;
		const target =
			direction > 0
				? turns.find((node) => node.getBoundingClientRect().top > top + 8)
				: [...turns].reverse().find((node) => node.getBoundingClientRect().top < top - 8);
		(target ?? (direction > 0 ? turns[turns.length - 1] : turns[0]))?.scrollIntoView({ block: "start" });
	};
	// Desktop menu actions reuse the same entry points as the keyboard and the sidebar.
	window.amazmeDesktop?.onMenuAction?.((action) => {
		if (action === "new-session") renderer.onShortcut("session.new");
		else if (action === "settings") elements.settingsButton.click();
	});
	document.addEventListener("selectionchange", scheduleQuoteAction);
	document.addEventListener("mouseup", scheduleQuoteAction);
	document.addEventListener("keyup", scheduleQuoteAction);
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") hideQuoteAction();
	});
	window.addEventListener("scroll", hideQuoteAction, true);
	window.addEventListener("resize", hideQuoteAction);
	const gestureOf = (event: KeyboardEvent): ShortcutGesture => {
		if (isStopChord(event)) return { code: event.code, primary: false, alt: false, shift: false, control: true };
		const primary = isApplePlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
		return { code: event.code, primary, alt: event.altKey, shift: event.shiftKey };
	};
	/** The composer or another field is copying a selection, so Ctrl+C stays copy. */
	const copying = (event: KeyboardEvent): boolean => {
		const target = event.target;
		if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.selectionStart !== target.selectionEnd) return true;
		const selected = document.getSelection()?.toString() ?? "";
		return selected.length > 0;
	};
	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || elements.modalRoot.open) return;
		const fontAction = fontSizeShortcut(event, navigator.platform, window.amazmeDesktop !== undefined);
		if (fontAction !== undefined) {
			event.preventDefault();
			renderer.onShortcut(`font.${fontAction}`);
			return;
		}
		// Chat search owns the find chord on the conversation, the way settings owns it on its page.
		if (
			lastView?.panel.current === CHAT_VIEW &&
			event.code === "KeyF" &&
			(event.metaKey || event.ctrlKey) &&
			!event.altKey &&
			!event.shiftKey &&
			elements.modalRoot.hidden
		) {
			event.preventDefault();
			openTranscriptSearch();
			return;
		}
		// Settings search takes the find chord, the same way the settings page owns that field.
		if (
			lastView?.panel.current === SETTINGS_VIEW &&
			event.code === "KeyF" &&
			(event.metaKey || event.ctrlKey) &&
			!event.altKey &&
			!event.shiftKey &&
			elements.modalRoot.hidden
		) {
			event.preventDefault();
			elements.sectionSearch.hidden = false;
			if (libraryNav) libraryNav.hidden = false;
			elements.sectionSearchInput.focus();
			elements.sectionSearchInput.select();
			return;
		}
		const id = matchShortcut(gestureOf(event));
		if (id === "run.stop") {
			if (copying(event) || lastView?.busy !== true) return;
			event.preventDefault();
			renderer.onAbort();
			return;
		}
		const target = event.target;
		if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
			// A field owns the unmodified keys; the product shortcuts below still apply.
			if (!(event.altKey && (event.metaKey || event.ctrlKey))) return;
		}
		if (id === undefined) return;
		event.preventDefault();
		if (id === "transcript.previousPrompt" || id === "transcript.nextPrompt") {
			if (lastView?.panel.current === CHAT_VIEW) jumpPrompt(id === "transcript.nextPrompt" ? 1 : -1);
			return;
		}
		if (id === "composer.focus" && lastView?.panel.current === CHAT_VIEW) elements.prompt.focus();
		renderer.onShortcut(id);
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
		if (sessionMenu !== undefined) {
			event.preventDefault();
			closeSessionMenu(true);
			return;
		}
		if (meterExpanded) {
			event.preventDefault();
			setMeterExpanded(false, true);
			return;
		}
		if (elements.modalRoot.hidden === false) {
			event.preventDefault();
			requestModalClose();
			return;
		}
		const searchResultFocused = document.activeElement instanceof HTMLElement && elements.sectionNav.contains(document.activeElement);
		if (lastView?.panel.current === SETTINGS_VIEW && settingsQuery.length > 0 && searchResultFocused) {
			event.preventDefault();
			clearSettingsQuery();
			elements.sectionSearchInput.focus();
			return;
		}
		// A suggestion is dismissed from anywhere in the conversation, not only from the composer.
		if (visibleSuggestion()) {
			event.preventDefault();
			hideSuggestion();
			return;
		}
		// Escape never cancels a turn. While one is running it points at the stop control.
		if (lastView?.busy === true) elements.stop.focus();
	});
	elements.stop.addEventListener("click", () => {
		if (lastView?.busy !== true) return;
		renderer.onAbort();
	});

	return renderer;
}
