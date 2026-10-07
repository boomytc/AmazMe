/// <reference lib="dom" />
/**
 * Thin DOM renderer: it turns the pure view model into the page's shell markup and owns no
 * business state of its own. Every update rebuilds the flow, then restores the transcript's
 * scroll position so streaming does not yank the reader around. The one thing kept between
 * updates is the reader's own disclosure choices, keyed by block id, because a rebuild would
 * otherwise reset them.
 */
import { COMPACT_ACTION, DOCK_TAB_ACTION, DOCK_TOGGLE_ACTION, HISTORY_MORE_ACTION, REFRESH_MODELS_ACTION, SUBMIT_MODE_ACTION } from "./actions.ts";
import { FALLBACK_LOCALE } from "./locale.ts";
import { formatMarkdown, type InlineNode, type MarkdownNode, type TableAlignment, type TableNode } from "./markdown.ts";
import {
	CHAT_VIEW,
	type PanelAction,
	type PanelButton,
	type PanelControl,
	type PanelGroup,
	type PanelInput,
	type PanelModal,
	type PanelPending,
	type PanelRow,
	type PanelSpec,
	type PanelText,
	SETTINGS_VIEW,
} from "./panels.ts";
import { isApplePlatform, isStopChord, matchShortcut, type ShortcutGesture, type ShortcutId } from "./shortcuts.ts";
import { type MessageKey, translate } from "./strings.ts";
import {
	type Attachment,
	composerPlaceholder,
	type FeedbackControls,
	type QueueItem,
	type RosterItem,
	type TranscriptBlock,
	type WebView,
	type WelcomeCard,
	windowTitle,
} from "./view.ts";

export interface PageElements {
	readonly connection: HTMLElement;
	readonly mode: HTMLElement;
	readonly sessionTitle: HTMLElement;
	readonly laneStatus: HTMLElement;
	/** The sidebar's new-session bar. */
	readonly newSession: HTMLButtonElement;
	/** The sidebar's panel rows, and the settings entry in its footer. */
	readonly nav: HTMLElement;
	readonly settingsButton: HTMLButtonElement;
	/** The header's management entry, shown where the sidebar column is dropped. */
	readonly viewMenuTrigger: HTMLButtonElement;
	readonly viewMenu: HTMLElement;
	readonly roster: HTMLElement;
	readonly transcript: HTMLElement;
	readonly column: HTMLElement;
	/** The management panel's host, its back control, and the composer the panel replaces. */
	readonly view: HTMLElement;
	readonly viewBody: HTMLElement;
	readonly viewBack: HTMLButtonElement;
	readonly composerDock: HTMLElement;
	readonly modalRoot: HTMLElement;
	readonly queue: HTMLElement;
	readonly composer: HTMLFormElement;
	readonly prompt: HTMLTextAreaElement;
	/** Send. Stopping a turn is the separate stop control, not this button. */
	readonly primary: HTMLButtonElement;
	/** Stops the running turn. Hidden while the session is idle. */
	readonly stop: HTMLButtonElement;
	/** Pending approvals. Always in the header, beside the usage figures. */
	readonly approvalStatus: HTMLElement;
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
	/** The roster's filter, and the images attached but not sent yet, with the controls that add them. */
	readonly rosterFilter: HTMLInputElement;
	readonly attachments: HTMLElement;
	readonly attach: HTMLButtonElement;
	readonly fileInput: HTMLInputElement;
	/** The model and effort chip, and the card it opens. */
	readonly modelTrigger: HTMLButtonElement;
	readonly modelLabel: HTMLElement;
	readonly modelEffort: HTMLElement;
	readonly modelMenu: HTMLElement;
}

export interface PageRenderer {
	render(view: WebView): void;
	setConnection(text: string, kind: "state" | "error"): void;
	/** Handlers the page entry fills in once it can drive the host. */
	onSelect: (sessionId: string) => void;
	onCreateSession: () => void;
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
	/** The reader picked a palette row: the composer takes its text. */
	onCommandPick: (value: string) => void;
	/** Put text in the composer, the way a completion does. */
	setDraft(text: string): void;
	/** Every navigation, control, and modal report from the management surface. */
	onPanelAction: (action: PanelAction) => void;
	/** The view the composer's enabled state and placeholder were last rendered from. */
	readonly view: WebView | undefined;
}

export function collectPageElements(): PageElements {
	return {
		connection: pick("connection"),
		mode: pick("mode"),
		sessionTitle: pick("session-title"),
		laneStatus: laneStatusElement(),
		newSession: pickElement("new-session", HTMLButtonElement),
		nav: pick("nav"),
		settingsButton: pickElement("settings-button", HTMLButtonElement),
		viewMenuTrigger: pickElement("view-menu-trigger", HTMLButtonElement),
		viewMenu: pick("view-menu"),
		roster: pick("roster"),
		transcript: pick("transcript"),
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
		rosterFilter: pickElement("roster-filter", HTMLInputElement),
		attachments: pick("attachments"),
		attach: pickElement("attach", HTMLButtonElement),
		fileInput: pickElement("file-input", HTMLInputElement),
		composerDock: pick("composer-dock"),
		modalRoot: pick("modal-root"),
		queue: pick("queue"),
		composer: pickElement("composer", HTMLFormElement),
		prompt: pickElement("prompt", HTMLTextAreaElement),
		primary: pickElement("primary", HTMLButtonElement),
		stop: pickElement("stop", HTMLButtonElement),
		approvalStatus: pick("approval-status"),
		meter: pick("status-meter"),
		meterContext: pick("meter-context"),
		meterTokens: pick("meter-tokens"),
		meterCost: pick("meter-cost"),
		submitModes: pick("submit-modes"),
		modelTrigger: pickElement("model-trigger", HTMLButtonElement),
		modelLabel: pick("model-label"),
		modelEffort: pick("model-effort"),
		modelMenu: pick("model-menu"),
	};
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
	readonly codeBlock: (text: string, language: string | undefined) => HTMLElement;
}

function markdownNode(node: MarkdownNode, context: MarkdownContext): HTMLElement {
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
			return context.codeBlock(node.text, node.language);
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

/** An answer as DSH's markdown sheet expects it: one `.markdown` root per assistant block. */
function markdownElement(text: string, context: MarkdownContext): HTMLElement {
	const root = element("div", "markdown");
	for (const node of formatMarkdown(text)) root.append(markdownNode(node, context));
	return root;
}

/** The 14px trailing check a selected picker row carries (ModelSelect's `.check`). */
function checkGlyph(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("width", "14");
	svg.setAttribute("height", "14");
	svg.setAttribute("aria-hidden", "true");
	const shape = document.createElementNS(SVG_NAMESPACE, "path");
	shape.setAttribute("d", "M3.4 8.6 6.6 11.8 12.6 5.2");
	shape.setAttribute("fill", "none");
	shape.setAttribute("stroke", "currentColor");
	shape.setAttribute("stroke-width", "1.6");
	shape.setAttribute("stroke-linecap", "round");
	shape.setAttribute("stroke-linejoin", "round");
	svg.append(shape);
	return svg;
}

/** The leading 16px glyph box every disclosure row and notice row carries. */
function leading(): HTMLElement {
	return element("span", "disclosure-leading");
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
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) return false;
	return parsed >= (control.min ?? Number.NEGATIVE_INFINITY);
}

function fitPrompt(prompt: HTMLTextAreaElement): void {
	prompt.style.height = "auto";
	// The draft grows with its content; the sheet caps it at `--dsh-composer-text-max-height` and
	// the box scrolls once it is capped.
	prompt.style.height = `${prompt.scrollHeight}px`;
}

/** One 16px outline glyph per navigation row; the page ships its own shapes, not an icon set. */
function navGlyph(name: "chat" | "plugins" | "skills" | "automation" | "settings"): SVGSVGElement {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("aria-hidden", "true");
	const shapes: Record<typeof name, string[]> = {
		chat: ["M3.2 4.2h9.6v6.4H7.6L4.6 13v-2.4H3.2Z"],
		plugins: ["M3.6 3.6h3.6v3.6H3.6zM8.8 3.6h3.6v3.6H8.8zM3.6 8.8h3.6v3.6H3.6zM8.8 8.8h3.6v3.6H8.8z"],
		skills: ["M8 2.6 9.6 6.4 13.4 8 9.6 9.6 8 13.4 6.4 9.6 2.6 8 6.4 6.4Z"],
		// A clock: the dial, then the two hands from its centre.
		automation: ["M8 2.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 8 2.8Z", "M8 5.6v2.7l1.9 1.1"],
		settings: ["M2.6 5.2h10.8M2.6 10.8h10.8"],
	};
	for (const definition of shapes[name]) {
		const shape = document.createElementNS(SVG_NAMESPACE, "path");
		shape.setAttribute("d", definition);
		shape.setAttribute("fill", "none");
		shape.setAttribute("stroke", "currentColor");
		shape.setAttribute("stroke-width", "1.4");
		shape.setAttribute("stroke-linecap", "round");
		shape.setAttribute("stroke-linejoin", "round");
		svg.append(shape);
	}
	if (name === "settings") {
		// Two knobs on the sliders, painted in the surface colour so the line reads through them.
		for (const [cx, cy] of [
			["6.2", "5.2"],
			["9.8", "10.8"],
		] as const) {
			const knob = document.createElementNS(SVG_NAMESPACE, "circle");
			knob.setAttribute("cx", cx);
			knob.setAttribute("cy", cy);
			knob.setAttribute("r", "1.5");
			knob.setAttribute("fill", "var(--dsw-alias-bg-base)");
			knob.setAttribute("stroke", "currentColor");
			knob.setAttribute("stroke-width", "1.4");
			svg.append(knob);
		}
	}
	return svg;
}

/** The thumb a rating control carries, up or down. */
function thumbGlyph(direction: "up" | "down"): SVGSVGElement {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("width", "14");
	svg.setAttribute("height", "14");
	svg.setAttribute("aria-hidden", "true");
	const shape = document.createElementNS(SVG_NAMESPACE, "path");
	shape.setAttribute(
		"d",
		direction === "up"
			? "M5.6 13.4V7.2l2.6-4.6h1.1l-.6 3.5h3a1.2 1.2 0 0 1 1.2 1.4l-.7 4.1a1.2 1.2 0 0 1-1.2 1H5.6Zm0 0H3.4V7.2h2.2"
			: "M10.4 2.6v6.2L7.8 13.4H6.7l.6-3.5h-3A1.2 1.2 0 0 1 3.1 8.5l.7-4.1a1.2 1.2 0 0 1 1.2-1h4.1Zm0 0h2.2v6.2h-2.2",
	);
	shape.setAttribute("fill", "none");
	shape.setAttribute("stroke", "currentColor");
	shape.setAttribute("stroke-width", "1.3");
	shape.setAttribute("stroke-linecap", "round");
	shape.setAttribute("stroke-linejoin", "round");
	svg.append(shape);
	return svg;
}

/** The modal's close mark: two strokes, the same 16px box the other glyphs use. */
function closeGlyph(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("aria-hidden", "true");
	const shape = document.createElementNS(SVG_NAMESPACE, "path");
	shape.setAttribute("d", "M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4");
	shape.setAttribute("fill", "none");
	shape.setAttribute("stroke", "currentColor");
	shape.setAttribute("stroke-width", "1.5");
	shape.setAttribute("stroke-linecap", "round");
	svg.append(shape);
	return svg;
}

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

function panelButton(action: PanelButton, report: (action: PanelAction) => void, pending?: PanelPending): HTMLButtonElement {
	const node = button(`panel-button tone-${action.tone}`);
	node.dataset.action = action.id;
	if (action.data !== undefined) node.dataset.actionData = action.data;
	node.textContent = action.label;
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
	/** Reader disclosure choices, keyed by block id so a rebuild keeps them. */
	const expanded = new Map<TranscriptBlock["id"], boolean>();
	/** Text a reader is typing into a panel control, keyed by action id and target. */
	const drafts = new Map<string, string>();
	/** The modal already in the DOM; a rebuild would drop what the reader typed into it. */
	let modalKey: string | undefined;
	/** The open modal's submit and message line, so a state flip updates them without a rebuild. */
	let modalSubmit: HTMLButtonElement | undefined;
	let modalMessage: HTMLParagraphElement | undefined;

	const draft = (): string => elements.prompt.value.trim();

	/** The language of the view being painted; the fallback only applies before the first paint. */
	const copy = (key: MessageKey, values?: Record<string, string>): string => translate(lastView?.locale ?? FALLBACK_LOCALE, key, values);

	const report = (action: PanelAction): void => renderer.onPanelAction(action);

	const controlKey = (control: PanelControl): string => `${control.id}\u0000${control.data ?? ""}`;

	/** One control: a switch applies at once, a select at once, text and numbers on commit. */
	const controlElement = (control: PanelControl, pending?: PanelPending): HTMLElement => {
		const key = controlKey(control);
		const emit = (value: string): void => {
			drafts.delete(key);
			report({ kind: "control", id: control.id, data: control.data, value });
		};
		if (control.kind === "switch") {
			const label = element("label", "panel-switch");
			const input = document.createElement("input");
			input.type = "checkbox";
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
			for (const option of control.options ?? []) {
				const node = document.createElement("option");
				node.value = option.value;
				node.textContent = option.label;
				node.selected = option.value === control.value;
				select.append(node);
			}
			select.disabled = control.disabled === true;
			select.addEventListener("change", () => emit(select.value));
			markPending(select, pending, control);
			return select;
		}
		const input = document.createElement("input");
		input.className = control.kind === "number" ? "panel-input panel-number" : "panel-input";
		input.type = control.kind === "number" ? "number" : "text";
		input.value = drafts.get(key) ?? control.value;
		if (control.placeholder !== undefined) input.placeholder = control.placeholder;
		if (control.min !== undefined) input.min = String(control.min);
		if (control.step !== undefined) input.step = String(control.step);
		input.disabled = control.disabled === true;
		input.addEventListener("input", () => drafts.set(key, input.value));
		markPending(input, pending, control);
		input.addEventListener("change", () => {
			// A number outside the host's range is answered here, in the reader's language, and
			// keeps the draft so the reader can correct it instead of losing what they typed.
			if (control.kind === "number" && !inRange(control, input.value)) {
				input.title = copy("panel.settings.invalidNumber", {
					min: String(control.min ?? 0),
				});
				input.classList.add("invalid");
				input.setAttribute("aria-invalid", "true");
				return;
			}
			input.title = "";
			input.classList.remove("invalid");
			input.removeAttribute("aria-invalid");
			emit(input.value);
		});
		return input;
	};

	const rowElementOf = (row: PanelRow, pending?: PanelPending): HTMLElement => {
		const node = element("div", "panel-row");
		node.dataset.rowId = row.id;
		const text = element("div", "panel-row-text");
		const head = element("div", "panel-row-head");
		head.append(element("span", "panel-row-title", row.title));
		for (const badge of row.badges ?? []) head.append(element("span", "panel-badge", badge));
		text.append(head);
		if (row.description !== undefined) text.append(element("p", "panel-row-desc", row.description));
		if (row.value !== undefined) text.append(element("code", "panel-row-value", row.value));
		node.append(text);
		if (row.controls !== undefined && row.controls.length > 0) {
			const controls = element("div", "panel-controls");
			for (const control of row.controls) controls.append(controlElement(control, pending));
			node.append(controls);
		}
		if (row.actions !== undefined && row.actions.length > 0) {
			const actions = element("div", "panel-actions");
			for (const action of row.actions) actions.append(panelButton(action, report, pending));
			node.append(actions);
		}
		return node;
	};

	const groupElement = (group: PanelGroup, pending?: PanelPending): HTMLElement => {
		const node = element("section", "panel-group");
		const head = element("header", "panel-group-head");
		const titles = element("div", "panel-group-titles");
		titles.append(element("h2", "panel-group-title", group.title));
		if (group.description !== undefined) titles.append(element("p", "panel-group-desc", group.description));
		head.append(titles);
		if (group.actions !== undefined && group.actions.length > 0) {
			const actions = element("div", "panel-actions");
			for (const action of group.actions) actions.append(panelButton(action, report, pending));
			head.append(actions);
		}
		node.append(head);
		const rows = element("div", "panel-rows");
		if (group.rows.length === 0) rows.append(element("p", "panel-empty", group.empty ?? copy("panel.empty")));
		else for (const row of group.rows) rows.append(rowElementOf(row, pending));
		node.append(rows);
		if (group.footnote !== undefined) node.append(element("p", "panel-footnote", group.footnote));
		return node;
	};

	/**
	 * One input line: the reader types, the submit control runs it. A repaint reuses the same row
	 * for the same input, so a command being typed (or a focused field) survives the dock's output
	 * landing underneath it.
	 */
	const inputElement = (input: PanelInput, existing?: HTMLElement): HTMLElement => {
		if (existing !== undefined && existing.dataset.inputRow === input.id) {
			const field = existing.querySelector("input");
			if (field !== null) field.placeholder = input.placeholder;
			const submit = existing.querySelector("button");
			if (submit !== null) submit.disabled = input.submit.disabled === true;
			return existing;
		}
		const form = element("form", "panel-input-row");
		form.dataset.inputRow = input.id;
		const field = document.createElement("input");
		field.type = "text";
		field.className = "panel-input panel-input-wide";
		field.placeholder = input.placeholder;
		field.value = input.value;
		field.autocomplete = "off";
		field.spellcheck = false;
		// The submit control carries what the reader typed, which is why it does not go through
		// the shared button helper: that one reports a fixed action id and subject.
		const submit = button(`panel-button tone-${input.submit.tone}`);
		submit.dataset.action = input.submit.id;
		submit.textContent = input.submit.label;
		submit.disabled = input.submit.disabled === true;
		const run = (): void => report({ kind: "command", id: input.submit.id, data: field.value });
		submit.addEventListener("click", run);
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			run();
		});
		form.append(field, submit);
		return form;
	};

	/** One text block: a file's content or a terminal's output, kept as text. */
	const textElement = (text: PanelText): HTMLElement => {
		const block = element("div", "panel-text-block");
		if (text.title !== undefined) block.append(element("p", "panel-text-title", text.title));
		if (text.text.length === 0 && text.empty !== undefined) {
			block.append(element("p", "panel-empty", text.empty));
			return block;
		}
		block.append(element("pre", "panel-text", text.text));
		return block;
	};

	const panelElement = (panel: PanelSpec, container?: HTMLElement): HTMLElement => {
		const node = element("div", "panel");
		const head = element("header", "panel-head");
		head.append(element("h1", "panel-title", panel.title));
		if (panel.description !== undefined) head.append(element("p", "panel-desc", panel.description));
		node.append(head);
		for (const notice of panel.notices) node.append(element("p", `panel-notice ${notice.tone}`, notice.text));
		const previousInput = container?.querySelector<HTMLElement>("form[data-input-row]") ?? undefined;
		for (const input of panel.inputs ?? []) node.append(inputElement(input, previousInput));
		for (const group of panel.groups) node.append(groupElement(group, panel.pending));
		for (const text of panel.texts ?? []) node.append(textElement(text));
		return node;
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
		if (modalSubmit !== undefined) {
			modalSubmit.disabled = modal.pending === true;
			modalSubmit.classList.toggle("pending", modal.pending === true);
			if (modal.pending === true) modalSubmit.setAttribute("aria-busy", "true");
			else modalSubmit.removeAttribute("aria-busy");
		}
		if (modalMessage !== undefined) {
			const notice = modal.notice;
			modalMessage.textContent = notice?.text ?? "";
			modalMessage.className = notice === undefined ? "modal-notice" : `modal-notice ${notice.tone}`;
			modalMessage.hidden = notice === undefined;
		}
	};

	const renderModal = (modal: PanelModal | undefined): void => {
		const key =
			modal === undefined ? undefined : `${modal.id}\u0000${modal.data ?? ""}\u0000${modal.fields.map((field) => `${field.id}=${field.value}`).join("\u0001")}`;
		if (key === modalKey) {
			if (modal !== undefined) applyModalState(modal);
			return;
		}
		modalKey = key;
		if (modal === undefined) {
			modalSubmit = undefined;
			modalMessage = undefined;
			elements.modalRoot.replaceChildren();
			elements.modalRoot.hidden = true;
			return;
		}
		const backdrop = element("div", "modal-backdrop");
		backdrop.addEventListener("click", () => report({ kind: "modal-close" }));
		const card = element("div", "modal-card");
		card.setAttribute("role", "dialog");
		card.setAttribute("aria-modal", "true");
		const head = element("header", "modal-head");
		const titles = element("div", "modal-titles");
		titles.append(element("h2", "modal-title", modal.title));
		if (modal.description !== undefined) titles.append(element("p", "modal-desc", modal.description));
		const close = button("modal-close");
		close.setAttribute("aria-label", copy("panel.dismiss"));
		close.append(closeGlyph());
		close.addEventListener("click", () => report({ kind: "modal-close" }));
		head.append(titles, close);
		const body = element("div", "modal-body");
		const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
		for (const field of modal.fields) {
			const label = element("label", "modal-field");
			label.append(element("span", "modal-field-label", field.label));
			const input = field.kind === "textarea" ? document.createElement("textarea") : document.createElement("input");
			if (input instanceof HTMLInputElement) input.type = "text";
			// The file and JSON fields are code; prose instructions keep the text face.
			const code = field.id === "content" || field.id === "entry";
			input.className = field.kind === "textarea" ? `modal-textarea${code ? " code" : ""}` : "modal-input";
			input.value = field.value;
			if (field.placeholder !== undefined) input.placeholder = field.placeholder;
			inputs.set(field.id, input);
			label.append(input);
			body.append(label);
		}
		const foot = element("footer", "modal-foot");
		const cancel = button("panel-button default");
		cancel.textContent = copy("panel.cancel");
		cancel.addEventListener("click", () => report({ kind: "modal-close" }));
		const submit = button(`panel-button ${modal.danger === true ? "tone-danger" : "tone-primary"}`);
		submit.textContent = modal.submit;
		submit.addEventListener("click", () => {
			const fields: Record<string, string> = {};
			for (const [id, input] of inputs) fields[id] = input.value;
			report({ kind: "modal-submit", id: modal.id, data: modal.data, fields });
		});
		foot.append(cancel, submit);
		const message = document.createElement("p");
		message.className = "modal-notice";
		message.hidden = true;
		card.append(head, body, message, foot);
		elements.modalRoot.replaceChildren(backdrop, card);
		elements.modalRoot.hidden = false;
		modalSubmit = submit;
		modalMessage = message;
		applyModalState(modal);
		const first = modal.fields[0] === undefined ? undefined : inputs.get(modal.fields[0].id);
		first?.focus();
	};

	/** The sidebar's navigation and the settings entry: one row per management view. */
	const renderNav = (view: WebView): void => {
		elements.nav.replaceChildren();
		for (const item of view.panel.nav) {
			if (item.id === SETTINGS_VIEW) continue; // The settings row lives in the sidebar footer.
			const row = button(item.active ? "nav-row active" : "nav-row");
			row.dataset.view = item.id;
			row.append(navGlyph(item.glyph), element("span", "nav-label", item.label));
			row.addEventListener("click", () => report({ kind: "open", panel: item.id }));
			elements.nav.append(row);
		}
		elements.settingsButton.replaceChildren(navGlyph("settings"), element("span", "nav-label", copy("nav.settings")));
		elements.settingsButton.classList.toggle("active", view.panel.current === SETTINGS_VIEW);
		// The header entry carries the same rows, for the width where the sidebar column is dropped.
		if (!elements.viewMenu.hidden) renderViewMenu(view);
	};

	/** The header's management card: the same rows as the sidebar, marked with the open view. */
	const renderViewMenu = (view: WebView): void => {
		const rows: HTMLElement[] = [];
		for (const item of view.panel.nav) {
			const row = button(item.active ? "menu-item selected" : "menu-item");
			row.setAttribute("role", "menuitemradio");
			row.setAttribute("aria-checked", String(item.active));
			row.append(element("span", "menu-item-name", item.label));
			if (item.active) {
				const check = element("span", "menu-check");
				check.append(checkGlyph());
				row.append(check);
			}
			row.addEventListener("click", () => {
				closeViewMenu();
				report({ kind: "open", panel: item.id });
			});
			rows.push(row);
		}
		const scroll = element("div", "menu-scroll");
		scroll.append(...rows);
		elements.viewMenu.replaceChildren(scroll);
	};

	const closeViewMenu = (): void => {
		if (elements.viewMenu.hidden) return;
		elements.viewMenu.hidden = true;
		elements.viewMenuTrigger.setAttribute("aria-expanded", "false");
	};

	const openViewMenu = (): void => {
		if (lastView === undefined) return;
		renderViewMenu(lastView);
		elements.viewMenu.hidden = false;
		elements.viewMenuTrigger.setAttribute("aria-expanded", "true");
	};

	/** Switch the main area between the conversation and one panel, and paint the panel. */
	const renderPanelView = (view: WebView): void => {
		const panel = view.panel.panel;
		const open = panel !== undefined;
		elements.view.hidden = !open;
		elements.transcript.hidden = open;
		elements.composerDock.hidden = open;
		elements.viewBack.hidden = !open;
		if (panel === undefined) {
			elements.viewBody.replaceChildren();
			const label = view.sessionLabel ?? copy("header.noSession");
			elements.sessionTitle.textContent =
				view.focus === undefined
					? label
					: copy("header.conversation", {
							session: label,
							conversation: view.focus,
						});
			return;
		}
		elements.sessionTitle.textContent = panel.title;
		elements.viewBody.replaceChildren(panelElement(panel));
	};

	/** Send stays send. It is disabled when there is nothing to send. */
	const renderPrimary = (): void => {
		const pending = lastView?.attachments.length ?? 0;
		elements.primary.disabled = lastView?.attachedId === undefined || (draft().length === 0 && pending === 0);
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

	/** Context %, tokens, and cost. Painted on every view, including before a session is attached. */
	const renderMeter = (view: WebView): void => {
		elements.meterContext.textContent = view.meter.context;
		elements.meterTokens.textContent = view.meter.tokens;
		elements.meterCost.textContent = view.meter.cost;
		elements.meter.dataset.tone = view.meter.tone;
		elements.meter.setAttribute(
			"aria-label",
			copy("header.meter", {
				context: view.meter.context,
				tokens: view.meter.tokens,
				cost: view.meter.cost,
			}),
		);
	};

	/** A disclosure whose open state is the reader's, falling back to a per-block default. */
	const disclosure = (block: TranscriptBlock, className: string, defaultOpen: boolean): HTMLDetailsElement => {
		const details = document.createElement("details");
		details.className = `disclosure ${className}`.trim();
		details.open = expanded.get(block.id) ?? defaultOpen;
		// The click handler runs before the browser toggles, so the intent is the flipped value.
		details.addEventListener("click", () => expanded.set(block.id, !details.open));
		return details;
	};

	/** An answer's rating row: both ratings, the set one marked, each a control of its own. */
	const feedbackRow = (feedback: FeedbackControls): HTMLElement => {
		const row = element("div", "feedback-row");
		row.setAttribute("role", "group");
		const control = (button: PanelButton, direction: "up" | "down", selected: boolean): HTMLElement => {
			const node = panelButton(button, report);
			node.className = selected ? `feedback-button selected ${direction}` : `feedback-button ${direction}`;
			node.replaceChildren(thumbGlyph(direction));
			node.title = button.label;
			node.setAttribute("aria-label", button.label);
			node.setAttribute("aria-pressed", String(selected));
			return node;
		};
		row.append(control(feedback.up, "up", feedback.rating === "up"));
		row.append(control(feedback.down, "down", feedback.rating === "down"));
		return row;
	};

	/** The first-run guide: what the page is, and the three steps that make it useful. */
	const welcomeElement = (welcome: WelcomeCard): HTMLElement => {
		const card = element("div", "welcome-card");
		card.append(element("h2", "welcome-title", welcome.title), element("p", "welcome-body", welcome.body));
		const steps = element("div", "welcome-steps");
		for (const step of welcome.steps) steps.append(panelButton(step, report));
		card.append(steps, element("p", "welcome-note", welcome.note));
		const dismiss = panelButton(welcome.dismiss, report);
		dismiss.className = "welcome-dismiss";
		card.append(dismiss);
		return card;
	};

	/** A user turn: the images the entry carries, then its text. */
	const userBubble = (block: TranscriptBlock): HTMLElement => {
		const bubble = element("div", "bubble");
		for (const image of block.images ?? []) {
			const node = document.createElement("img");
			node.className = "bubble-image";
			node.src = image.dataUrl;
			node.alt = image.alt;
			bubble.append(node);
		}
		if (block.text.length > 0) bubble.append(element("span", "bubble-text", block.text));
		return bubble;
	};

	/** A row: the leading glyph, the title, and — when a summary is given — the dot and one line of it. */
	const rowElement = (block: TranscriptBlock, tag: "summary" | "div", summary?: string): HTMLElement => {
		const line = element(tag, "disclosure-row");
		line.append(leading(), element("span", "disclosure-title", block.title));
		if (summary !== undefined && summary.length > 0) {
			line.append(element("span", "disclosure-sep"), element("span", "disclosure-summary", summary));
		}
		return line;
	};

	/** A tool call: running starts open, settled starts folded. The row is the short args digest; the body keeps those args and the result. */
	const toolElement = (block: TranscriptBlock): HTMLElement => {
		const tone = block.running ? "running" : block.tone === "error" ? "error" : "";
		const details = disclosure(block, tone, block.running);
		const digest = block.toolArgs?.collapsed;
		const summary = digest !== undefined && digest.length > 0 ? digest : firstLine(block.text);
		details.append(rowElement(block, "summary", summary));
		if (block.toolArgs !== undefined && block.toolArgs.expanded.length > 0) {
			details.append(element("div", "tool-args", block.toolArgs.expanded));
		}
		if (block.text.length > 0) {
			details.append(element("div", "tool-output", block.text));
		} else if (!block.running) {
			details.append(element("div", "tool-output empty", copy("tool.noOutput")));
		}
		return details;
	};

	/** Assistant reasoning: the Think row, collapsed until the reader opens it. */
	const reasoningElement = (block: TranscriptBlock): HTMLElement => {
		const details = disclosure(block, "", false);
		details.append(rowElement(block, "summary"), element("div", "reasoning-body", block.text));
		return details;
	};

	/** One roster row: the session's id and working directory, its age, and its remove control. */
	const sessionRow = (item: RosterItem): HTMLElement => {
		const chip = button(item.attached ? "session-row attached" : "session-row");
		chip.dataset.sessionId = item.id;
		if (item.label !== item.id) chip.title = item.id;
		const text = element("span", "session-text");
		const name = element("span", "session-name", item.label);
		// A terminal session a host has not adopted yet is worth naming: attaching it adopts it.
		if (item.source === "local") name.append(element("span", "session-source", copy("sidebar.localSession")));
		text.append(name);
		if (item.cwd !== undefined && item.cwd.length > 0) {
			text.append(element("span", "session-cwd", item.cwd));
		}
		chip.append(text);
		const age = element("time", "session-age", item.age);
		age.setAttribute("datetime", item.ageIso);
		chip.append(age);
		const remove = panelButton(item.remove, report);
		remove.className = "session-remove";
		remove.replaceChildren(closeGlyph());
		remove.title = copy("sidebar.removeAria");
		remove.setAttribute("aria-label", copy("sidebar.removeAria"));
		remove.addEventListener("click", (event) => event.stopPropagation());
		chip.append(remove);
		chip.addEventListener("click", () => renderer.onSelect(item.id));
		return chip;
	};

	/** A fenced code block: the language, the code, and a copy control whose text is the code. */
	const codeBlockElement = (text: string, language: string | undefined): HTMLElement => {
		const block = element("div", "code-block");
		const head = element("div", "code-head");
		if (language !== undefined) head.append(element("span", "code-language", language));
		const control = button("code-copy");
		control.dataset.action = "copy";
		control.textContent = copy("copy.copy");
		control.addEventListener("click", () => {
			const written = navigator.clipboard?.writeText(text);
			if (written === undefined) {
				control.textContent = copy("copy.failed");
				return;
			}
			void written.then(
				() => {
					control.textContent = copy("copy.copied");
					window.setTimeout(() => {
						control.textContent = copy("copy.copy");
					}, 1200);
				},
				() => {
					control.textContent = copy("copy.failed");
				},
			);
		});
		head.append(control);
		block.append(head);
		const pre = document.createElement("pre");
		const code = document.createElement("code");
		code.textContent = text;
		pre.append(code);
		block.append(pre);
		return block;
	};

	/** What the markdown adapter borrows from the renderer. */
	const markdown: MarkdownContext = { copy, codeBlock: codeBlockElement };

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
			// A command this client cannot run is shown as such: the row picks its text, and the
			// host answers with the reason when it is submitted.
			if (row.disabled === true) classes.push("unavailable");
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
		const image = document.createElement("img");
		image.src = attachment.dataUrl;
		image.alt = attachment.name;
		card.append(image);
		const meta = element("figcaption", "attachment-meta");
		meta.append(element("span", "attachment-name", attachment.name), element("span", "attachment-size", attachment.size));
		card.append(meta);
		const remove = panelButton(attachment.remove, report);
		remove.className = "attachment-remove";
		// The strip shows a mark; the control's name is the accessible one.
		remove.replaceChildren(closeGlyph());
		remove.title = attachment.remove.label;
		remove.setAttribute("aria-label", attachment.remove.label);
		card.append(remove);
		return card;
	};

	/** One queued input: what it is, and the withdraw that names only this submission. */
	const queueElement = (item: QueueItem): HTMLElement => {
		const row = element("p", "queue-item");
		row.dataset.submissionId = item.id;
		row.append(element("span", "queue-text", item.text));
		const cancel = panelButton(item.cancel, report);
		cancel.className = "queue-cancel";
		cancel.title = copy("queue.cancelAria");
		cancel.setAttribute("aria-label", copy("queue.cancelAria"));
		row.append(cancel);
		return row;
	};

	/** The dock: the tabs, the open tab's panel, and the class that gives it a column. */
	const renderDock = (view: WebView): void => {
		elements.dock.hidden = !view.dock.open;
		document.body.classList.toggle("dock-open", view.dock.open);
		if (!view.dock.open) {
			elements.dockTabs.replaceChildren();
			elements.dockBody.replaceChildren();
			return;
		}
		const tabs = element("div", "dock-tab-row");
		for (const tab of view.dock.tabs) {
			const node = button(tab.active ? "dock-tab active" : "dock-tab");
			node.dataset.tab = tab.id;
			node.setAttribute("role", "tab");
			node.setAttribute("aria-selected", String(tab.active));
			node.textContent = tab.label;
			node.addEventListener("click", () => report({ kind: "command", id: DOCK_TAB_ACTION, data: tab.id }));
			tabs.append(node);
		}
		elements.dockTabs.replaceChildren(tabs);
		elements.dockBody.replaceChildren(panelElement(view.dock.panel, elements.dockBody));
	};

	/** The header's run controls: one control per action the view offers. */
	const renderRunActions = (view: WebView): void => {
		const compact = panelButton(view.run.compact, report);
		compact.className = "header-action";
		compact.dataset.action = COMPACT_ACTION;
		const fork = panelButton(view.run.fork, report);
		fork.className = "header-action";
		fork.dataset.action = "conversation:fork";
		const dock = button(view.dock.toggle.pressed ? "header-action pressed" : "header-action");
		dock.dataset.action = DOCK_TOGGLE_ACTION;
		dock.textContent = view.dock.toggle.label;
		dock.setAttribute("aria-pressed", String(view.dock.toggle.pressed));
		dock.addEventListener("click", () => report({ kind: "command", id: DOCK_TOGGLE_ACTION, data: undefined }));
		elements.runActions.replaceChildren(compact, fork, dock);
		elements.laneStatus.textContent = view.lane;
		elements.laneStatus.hidden = view.lane.length === 0;
	};

	/** The composer's submit mode, offered only while a turn runs and can take input. */
	const renderSubmitModes = (view: WebView): void => {
		if (!view.busy) {
			elements.submitModes.replaceChildren();
			elements.submitModes.hidden = true;
			return;
		}
		const group = element("div", "mode-group");
		group.setAttribute("role", "radiogroup");
		group.setAttribute("aria-label", copy("composer.modesAria"));
		for (const option of view.run.submitModes) {
			const node = button(option.selected ? "mode-option selected" : "mode-option");
			node.dataset.mode = option.mode;
			node.setAttribute("role", "radio");
			node.setAttribute("aria-checked", String(option.selected));
			node.textContent = option.label;
			node.addEventListener("click", () => report({ kind: "command", id: SUBMIT_MODE_ACTION, data: option.mode }));
			group.append(node);
		}
		elements.submitModes.replaceChildren(group);
		elements.submitModes.hidden = false;
	};

	/** A flow notice (compaction, new context): one 24px row, with its summary indented below. */
	const noticeElement = (block: TranscriptBlock): HTMLElement => {
		const group = element("div", "disclosure");
		group.append(rowElement(block, "div"));
		if (block.text.length > 0) group.append(element("div", "notice-body", block.text));
		return group;
	};

	/** A failed turn: a status dot, the failure's title, and its message. */
	const errorElement = (block: TranscriptBlock): HTMLElement => {
		const line = element("div", "error-row");
		const copy = element("div", "error-copy");
		copy.append(element("span", "error-title", block.title), element("span", "error-message", block.text));
		line.append(element("span", "error-dot"), copy);
		return line;
	};

	/** The live status line (DSH's ChatView `.running`), the flow's last item while a turn runs. */
	const runningElement = (status: string): HTMLElement => {
		const line = element("div", "running");
		line.append(element("span", "running-text", status));
		return line;
	};

	const isProcess = (block: TranscriptBlock): boolean => block.kind === "thinking" || block.kind === "tool";

	/** The flow: user and assistant turns, one group per run of process rows, notices, the status. */
	const flowElements = (blocks: readonly TranscriptBlock[]): HTMLElement[] => {
		const flow: HTMLElement[] = [];
		let process: HTMLElement | undefined;
		for (const block of blocks) {
			if (isProcess(block)) {
				if (process === undefined) {
					process = element("div", "turn-process");
					flow.push(process);
				}
				process.append(block.kind === "tool" ? toolElement(block) : reasoningElement(block));
				continue;
			}
			process = undefined;
			if (block.kind === "user") flow.push(wrap("turn-user", userBubble(block)));
			else if (block.kind === "assistant") {
				const answer = wrap("turn-response", markdownElement(block.text, markdown));
				if (block.feedback !== undefined) answer.append(feedbackRow(block.feedback));
				flow.push(answer);
			} else if (block.kind === "notice") flow.push(block.tone === "error" ? errorElement(block) : noticeElement(block));
		}
		return flow;
	};

	/** One picker row; the selected one carries the trailing check, DSH's selection marker. */
	const pickerRow = (label: string, selected: boolean, choose: () => void): HTMLButtonElement => {
		const row = button(selected ? "menu-item selected" : "menu-item");
		row.setAttribute("role", "menuitemradio");
		row.setAttribute("aria-checked", String(selected));
		row.append(element("span", "menu-item-name", label));
		if (selected) {
			const check = element("span", "menu-check");
			check.append(checkGlyph());
			row.append(check);
		}
		row.addEventListener("click", () => {
			closeModelMenu();
			choose();
		});
		return row;
	};

	/** The card the chip opens: the host's catalog under its providers, then the effort group. */
	const renderModelMenu = (view: WebView): void => {
		const picker = view.model;
		const rows: HTMLElement[] = [];
		if (picker.empty !== undefined) rows.push(element("p", "menu-empty", picker.empty));
		if (picker.groups.length > 0) {
			rows.push(element("p", "menu-heading", copy("model.heading")));
			for (const group of picker.groups) {
				rows.push(element("p", "menu-heading", group.provider));
				for (const option of group.options) {
					rows.push(pickerRow(option.label, option.selected, () => renderer.onSelectModel(option.provider, option.modelId)));
				}
			}
			if (picker.levels.length > 0 || picker.levelsEmpty !== undefined) {
				rows.push(element("div", "menu-separator"), element("p", "menu-heading", copy("model.effort")));
				if (picker.levels.length > 0) {
					for (const level of picker.levels) {
						rows.push(pickerRow(level.label, level.selected, () => renderer.onSelectThinking(level.level)));
					}
				} else if (picker.levelsEmpty !== undefined) {
					rows.push(element("p", "menu-empty", picker.levelsEmpty));
				}
			}
		}
		if (picker.refresh.status !== undefined || !picker.disabled) {
			rows.push(element("div", "menu-separator"));
			const row = element("div", "menu-refresh");
			if (picker.refresh.status !== undefined) {
				row.append(element("p", "menu-empty", picker.refresh.status));
			}
			const refresh = button("panel-button default menu-refresh-action");
			refresh.dataset.action = REFRESH_MODELS_ACTION;
			refresh.textContent = picker.refresh.label;
			refresh.disabled = picker.refresh.busy;
			refresh.addEventListener("click", () => report({ kind: "command", id: REFRESH_MODELS_ACTION, data: undefined }));
			row.append(refresh);
			rows.push(row);
		}
		const scroll = element("div", "menu-scroll");
		scroll.append(...rows);
		elements.modelMenu.replaceChildren(scroll);
	};

	const closeModelMenu = (): void => {
		if (elements.modelMenu.hidden) return;
		elements.modelMenu.hidden = true;
		elements.modelTrigger.setAttribute("aria-expanded", "false");
	};

	const openModelMenu = (): void => {
		if (lastView === undefined || lastView.model.disabled) return;
		renderModelMenu(lastView);
		elements.modelMenu.hidden = false;
		elements.modelTrigger.setAttribute("aria-expanded", "true");
	};

	/** The chip's text follows the host's replicated configuration on every render. */
	const renderModelChip = (view: WebView): void => {
		const picker = view.model;
		elements.modelTrigger.disabled = picker.disabled;
		elements.modelLabel.textContent = picker.label;
		elements.modelEffort.textContent = picker.effort ?? "";
		elements.modelEffort.hidden = picker.effort === undefined;
		const name = picker.effort === undefined ? picker.label : `${picker.label} · ${picker.effort}`;
		elements.modelTrigger.title = name;
		elements.modelTrigger.setAttribute("aria-label", copy("model.chipAria", { name }));
		if (picker.disabled) closeModelMenu();
		else if (!elements.modelMenu.hidden) renderModelMenu(view);
	};

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
		onCommandPick: () => {},
		onPanelAction: () => {},
		get view(): WebView | undefined {
			return lastView;
		},
		render(view: WebView): void {
			lastView = view;
			if (app !== undefined) writeWindowTitle(app, view);
			const stick = atBottom(elements.transcript);

			elements.newSession.disabled = !view.newSession.enabled;

			elements.roster.replaceChildren();
			for (const item of view.roster) elements.roster.append(sessionRow(item));
			// The filter keeps what the reader typed; only its value is ever set from the view.
			if (document.activeElement !== elements.rosterFilter) elements.rosterFilter.value = view.rosterFilter;
			if (view.roster.length === 0) {
				const empty = element("p", "empty-state", view.empty ?? copy("header.rosterEmpty"));
				empty.id = "roster-empty";
				elements.roster.append(empty);
			}

			const flow = flowElements(view.blocks);
			// The pages the reader asked for sit above the live transcript, in their own group.
			if (view.history.blocks.length > 0) {
				const pages = element("div", "history-pages");
				pages.append(...flowElements(view.history.blocks));
				flow.unshift(pages);
			}
			if (view.history.loading || view.history.more) {
				const more = element("div", "history-more");
				const control = button(view.history.loading ? "history-more-button loading" : "history-more-button");
				control.dataset.action = HISTORY_MORE_ACTION;
				control.disabled = view.history.loading;
				control.textContent = copy(view.history.loading ? "history.loading" : "history.more");
				control.addEventListener("click", () => report({ kind: "command", id: HISTORY_MORE_ACTION, data: undefined }));
				more.append(control);
				flow.unshift(more);
			}
			if (view.blocks.length === 0) {
				if (view.welcome !== undefined) {
					flow.push(welcomeElement(view.welcome));
				} else {
					const empty = element("p", "empty-state", copy(view.attachedId === undefined ? "header.noSessionAttached" : "header.noEntries"));
					empty.id = "transcript-empty";
					flow.push(empty);
				}
			}
			if (view.status.length > 0) flow.push(runningElement(view.status));
			elements.column.replaceChildren(...flow);
			if (stick) elements.transcript.scrollTop = elements.transcript.scrollHeight;

			const detached = view.attachedId === undefined;
			elements.prompt.disabled = detached;
			elements.prompt.placeholder = composerPlaceholder(view.locale, view.attachedId);
			renderPrimary();
			renderStop();
			renderApprovalStatus(view);
			renderMeter(view);

			elements.queue.replaceChildren();
			for (const item of view.queue) elements.queue.append(queueElement(item));

			renderModelChip(view);
			renderAttachments(view);
			renderPalette(view);
			renderApprovals(view);
			renderRunActions(view);
			renderDock(view);
			renderSubmitModes(view);
			renderNav(view);
			renderPanelView(view);
			renderModal(view.panel.modal);
		},
		setDraft(text: string): void {
			elements.prompt.value = text;
			fitPrompt(elements.prompt);
			renderPrimary();
			renderer.onDraftChange(text);
			elements.prompt.focus();
		},
		setConnection(text: string, kind: "state" | "error"): void {
			elements.connection.textContent = text;
			elements.connection.className = `connection ${kind}`;
		},
	};

	elements.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		if (lastView?.attachedId === undefined) return;
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
	elements.prompt.addEventListener("input", () => {
		fitPrompt(elements.prompt);
		// An empty draft disables send. The text decides whether the command palette is open.
		renderPrimary();
		renderer.onDraftChange(elements.prompt.value);
	});
	elements.prompt.addEventListener("keydown", (event) => {
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
		// Enter submits, Shift+Enter keeps the newline: the same contract the TUI composer uses.
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		elements.composer.requestSubmit();
	});
	elements.rosterFilter.addEventListener("input", () => renderer.onFilterRoster(elements.rosterFilter.value));
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
	elements.newSession.addEventListener("click", () => renderer.onCreateSession());
	// The footer entry toggles the settings panel, the same way its sidebar row does.
	elements.settingsButton.addEventListener("click", () =>
		report({
			kind: "open",
			panel: lastView?.panel.current === SETTINGS_VIEW ? CHAT_VIEW : SETTINGS_VIEW,
		}),
	);
	elements.viewBack.addEventListener("click", () => report({ kind: "open", panel: CHAT_VIEW }));
	elements.viewMenuTrigger.addEventListener("click", () => {
		if (elements.viewMenu.hidden) openViewMenu();
		else closeViewMenu();
	});
	// The management card closes on a click elsewhere and on Escape, like the model card.
	document.addEventListener("pointerdown", (event) => {
		if (elements.viewMenu.hidden) return;
		const target = event.target;
		if (target instanceof Node && (elements.viewMenu.contains(target) || elements.viewMenuTrigger.contains(target))) return;
		closeViewMenu();
	});
	elements.modelTrigger.addEventListener("click", () => {
		if (elements.modelMenu.hidden) openModelMenu();
		else closeModelMenu();
	});
	// The card closes on a click elsewhere and on Escape, so it can never strand the pointer.
	document.addEventListener("pointerdown", (event) => {
		if (elements.modelMenu.hidden) return;
		const target = event.target;
		if (target instanceof Node && (elements.modelMenu.contains(target) || elements.modelTrigger.contains(target))) return;
		closeModelMenu();
	});
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
		if (event.defaultPrevented || event.isComposing) return;
		const id = matchShortcut(gestureOf(event));
		if (id === "run.stop") {
			if (copying(event) || lastView?.busy !== true) return;
			event.preventDefault();
			renderer.onAbort();
			return;
		}
		const target = event.target;
		if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
			// A field owns the unmodified keys; the product shortcuts below still apply.
			if (!(event.altKey && (event.metaKey || event.ctrlKey))) return;
		}
		if (id === undefined) return;
		event.preventDefault();
		if (id === "composer.focus") elements.prompt.focus();
		renderer.onShortcut(id);
	});
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		if (elements.modalRoot.hidden === false) {
			event.preventDefault();
			report({ kind: "modal-close" });
			return;
		}
		if (!elements.viewMenu.hidden) {
			closeViewMenu();
			elements.viewMenuTrigger.focus();
			return;
		}
		if (!elements.modelMenu.hidden) {
			closeModelMenu();
			elements.modelTrigger.focus();
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
