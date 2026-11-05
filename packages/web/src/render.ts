/**
 * The contract between the page entry and its presentation. `page.ts` owns the only runtime and
 * mounts the React presentation directly; there is no second DOM renderer to keep in sync.
 */
import type { DirectoryListing } from "./directories.ts";
import type { Locale } from "./locale.ts";
import type { ApprovalPolicy } from "./permission-picker.ts";
import type { PanelAction } from "./panels.ts";
import type { ShortcutId } from "./shortcuts.ts";
import type { WebView } from "./view.ts";

/** The Python page entry identifies itself by name and version. */
export interface WindowApp {
	readonly name: string;
	readonly version: string;
}

/** Host diagnostics may be literal; connection status copy follows the current locale. */
type ConnectionText = string | ((locale: Locale) => string);
/**
 * `unavailable` means the host still answers but this window cannot attach to its session (for
 * example a policy close while the worker starts); network and identity failures are `disconnected`.
 */
type ConnectionState = "connecting" | "connected" | "unavailable" | "disconnected";

/** A transient message's weight in the top-right toast layer. */
export type ToastTone = "info" | "error";

export interface PageRenderer {
	syncDraft?(text: string): void;
	dispose?(): void;
	onTerminalInput?: (id: string, data: string) => void;
	onTerminalResize?: (id: string, cols: number, rows: number) => void;
	render(view: WebView): void;
	/**
	 * Post a message in the window's top-right layer. It never occupies page layout, and a repeated
	 * text reuses the standing card instead of stacking or restarting its clock. Transient cards
	 * retire after 2.5s; `persistent` cards wait for the reader to dismiss them.
	 */
	showToast(text: string, tone?: ToastTone, persistent?: boolean): void;
	/**
	 * Retire standing error cards once the connection recovers; informational cards keep their
	 * clocks. The accepted trade-off is one clear per recovery: a later failure posts again, so the
	 * page does not try to remember which card belonged to the connection that just recovered.
	 */
	clearErrorToasts(): void;
	/** Show connectivity on the brand mark. */
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
