import type { DirectoryListing } from "./directories.ts";
import type { Locale } from "./locale.ts";
import type { ApprovalPolicy } from "./permission-picker.ts";
import type { PanelAction } from "./panels.ts";
import type { ShortcutId } from "./shortcuts.ts";
import type { WebView } from "./view.ts";
import { Presentation } from "./react/state.ts";
import { mountPresentation } from "./react/mount.tsx";

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
	/** Pending approvals. Stays in the header when the transcript is empty or the cards are off screen. */
	readonly approvalStatus: HTMLElement;
	/** In-conversation search bar; the settings sidebar owns its own field. */
	readonly transcriptSearch: HTMLElement;
	readonly transcriptSearchInput: HTMLInputElement;
	readonly transcriptSearchCount: HTMLElement;
	readonly transcriptSearchClose: HTMLButtonElement;
	/** Context ring beside the model picker. Tokens and cost open in the hover card. */
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
	readonly questions: HTMLElement;
	/** The composer's command palette, filled by the renderer. */
	readonly palette: HTMLElement;
	/** Fork and the session tools. Compaction is on the context ring. */
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
	syncDraft?(text: string): void;
	dispose?(): void;
	onTerminalInput?: (id: string, data: string) => void;
	onTerminalResize?: (id: string, cols: number, rows: number) => void;
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
	onSelectPermission: (policy: ApprovalPolicy) => void;
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
		questions: pick("questions"),
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

export interface WindowApp {
	readonly name: string;
	readonly version: string;
}

/** Browser compatibility entry. The page entry owns its runtime and mounts React directly. */
export function createRenderer(elements: PageElements, onSelect: (sessionId: string) => void = () => {}, app?: WindowApp): PageRenderer {
	const presentation = new Presentation(app);
	presentation.onSelect = onSelect;
	let container = elements.center.closest<HTMLElement>("#amazme-root");
	if (!container) {
		container = document.createElement("div");
		container.id = "amazme-root";
		const rail = elements.nav.closest(".app-rail") ?? elements.nav;
		rail.before(container);
		container.append(rail, elements.sidebar, elements.center, elements.dock, elements.modalRoot);
	}
	mountPresentation(presentation, container);
	return presentation;
}
