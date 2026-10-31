import type { PageRenderer, WindowApp } from "../render.ts";
import type { WebView } from "../view.ts";
import { sameViewValue } from "../view-equality.ts";
import type { ComposerView, TranscriptView } from "./chat.tsx";

export class Snapshot<T> {
	private value: T;
	private readonly listeners = new Set<() => void>();
	private readonly equal: (left: T, right: T) => boolean;
	constructor(value: T, equal: (left: T, right: T) => boolean = sameViewValue) {
		this.value = value;
		this.equal = equal;
	}
	readonly getSnapshot = (): T => this.value;
	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	replace(value: T): boolean {
		if (this.equal(this.value, value)) return false;
		this.value = value;
		return true;
	}
	readonly notify = (): void => {
		for (const listener of [...this.listeners]) listener();
	};
	publish(value: T): void {
		if (this.replace(value)) this.notify();
	}
	clear(): void {
		this.listeners.clear();
	}
}

export type ShellView = Pick<
	WebView,
	| "locale"
	| "typography"
	| "roster"
	| "projects"
	| "archivedAttached"
	| "rosterFilter"
	| "newSession"
	| "transcriptScope"
	| "attachedId"
	| "sessionLabel"
	| "approvalIndicator"
	| "mirrorWarning"
	| "status"
	| "run"
	| "lane"
	| "readOnly"
	| "sessionDraft"
> & {
	readonly emptyTranscript: boolean;
	readonly pageTitle?: string;
	readonly dock: Pick<WebView["dock"], "open" | "toggle">;
	readonly panel: Pick<
		WebView["panel"],
		"nav" | "current" | "settingsSection"
	>;
};
function fields<T extends object>(
	keys: readonly (keyof T)[],
): (left: T | undefined, right: T | undefined) => boolean {
	return (left, right) =>
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			keys.every((key) => sameViewValue(left[key], right[key])));
}

export interface ConnectionNotice {
	readonly text: string | ((locale: WebView["locale"]) => string);
	readonly kind: "state" | "error";
	readonly state: "connecting" | "connected" | "disconnected";
}

/** Window-owned projection. Publishing never waits for a React commit or starts a command. */
export class Presentation implements PageRenderer {
	readonly state = new Snapshot<WebView | undefined>(undefined);
	readonly shell = new Snapshot<ShellView | undefined>(
		undefined,
		fields<ShellView>([
			"locale",
			"typography",
			"roster",
			"projects",
			"archivedAttached",
			"rosterFilter",
			"newSession",
			"transcriptScope",
			"attachedId",
			"sessionLabel",
			"approvalIndicator",
			"mirrorWarning",
			"status",
			"run",
			"lane",
			"readOnly",
			"sessionDraft",
			"emptyTranscript",
			"pageTitle",
			"dock",
			"panel",
		]),
	);
	readonly transcript = new Snapshot<TranscriptView | undefined>(
		undefined,
		fields<TranscriptView>([
			"locale",
			"transcriptScope",
			"attachedId",
			"readOnly",
			"blocks",
			"history",
			"status",
			"busy",
			"welcome",
			"roster",
			"rosterFilter",
			"newSession",
			"sessionDraft",
			"archivedAttached",
			"model",
			"empty",
		]),
	);
	readonly composer = new Snapshot<ComposerView | undefined>(
		undefined,
		fields<ComposerView>([
			"locale",
			"transcriptScope",
			"attachedId",
			"readOnly",
			"sessionDraft",
			"attachments",
			"approvals",
			"questions",
			"queue",
			"palette",
			"run",
			"model",
			"modelPending",
			"approvalPolicy",
			"busy",
			"suggestion",
			"commandLine",
			"shortcuts",
			"meter",
		]),
	);
	readonly management = new Snapshot<
		| Pick<WebView, "panel" | "locale" | "modelConnections" | "typography">
		| undefined
	>(
		undefined,
		fields<
			Pick<WebView, "panel" | "locale" | "modelConnections" | "typography">
		>(["panel", "locale", "modelConnections", "typography"]),
	);
	readonly dock = new Snapshot<WebView["dock"] | undefined>(undefined);
	readonly draft = new Snapshot("");
	readonly connection = new Snapshot<ConnectionNotice>({
		text: "正在连接",
		kind: "state",
		state: "connecting",
	});
	readonly app: WindowApp;
	private disposed = false;
	private pendingDraft = "";
	private unmount?: () => void;
	onSelect: PageRenderer["onSelect"] = () => {};
	onCreateSession: PageRenderer["onCreateSession"] = () => {};
	onBrowseDirectories?: PageRenderer["onBrowseDirectories"];
	onPickDirectories?: PageRenderer["onPickDirectories"];
	onSubmit: PageRenderer["onSubmit"] = () => {};
	onAbort: PageRenderer["onAbort"] = () => {};
	onSelectModel: PageRenderer["onSelectModel"] = () => {};
	onSelectThinking: PageRenderer["onSelectThinking"] = () => {};
	onSelectPermission: PageRenderer["onSelectPermission"] = () => {};
	onAttachFiles: PageRenderer["onAttachFiles"] = () => {};
	onFilterRoster: PageRenderer["onFilterRoster"] = () => {};
	onShortcut: PageRenderer["onShortcut"] = () => {};
	onPaletteSelection: PageRenderer["onPaletteSelection"] = () => {};
	onDraftChange: PageRenderer["onDraftChange"] = () => {};
	onDismissSuggestion: PageRenderer["onDismissSuggestion"] = () => {};
	onCommandPick: PageRenderer["onCommandPick"] = () => {};
	onPanelAction: PageRenderer["onPanelAction"] = () => {};
	onTerminalInput?: PageRenderer["onTerminalInput"];
	onTerminalResize?: PageRenderer["onTerminalResize"];
	readonly dispatchPanelAction: PageRenderer["onPanelAction"] = (action) =>
		this.onPanelAction(action);
	readonly dispatchTerminalInput: NonNullable<PageRenderer["onTerminalInput"]> =
		(id, data) => this.onTerminalInput?.(id, data);
	readonly dispatchTerminalResize: NonNullable<
		PageRenderer["onTerminalResize"]
	> = (id, cols, rows) => this.onTerminalResize?.(id, cols, rows);
	readonly browseDirectories: NonNullable<PageRenderer["onBrowseDirectories"]> =
		async (path) => {
			if (!this.onBrowseDirectories) throw new Error("目录浏览不可用");
			return this.onBrowseDirectories(path);
		};
	readonly pickDirectories: NonNullable<PageRenderer["onPickDirectories"]> =
		async () => this.onPickDirectories?.();
	constructor(app: WindowApp = { name: "AmazMe", version: "" }) {
		this.app = app;
	}
	get view(): WebView | undefined {
		return this.state.getSnapshot();
	}
	render(view: WebView): void {
		if (this.disposed) return;
		const notifications: Array<() => void> = [];
		const stage = <T>(snapshot: Snapshot<T>, value: T): void => {
			if (snapshot.replace(value)) notifications.push(snapshot.notify);
		};
		stage(this.state, view);
		stage(this.draft, this.pendingDraft);
		stage(this.shell, {
			...view,
			emptyTranscript:
				view.blocks.length === 0 && view.history.blocks.length === 0,
			pageTitle:
				view.panel.current === "chat"
					? view.sessionLabel
					: view.panel.panel?.title,
			dock: { open: view.dock.open, toggle: view.dock.toggle },
			panel: {
				nav: view.panel.nav,
				current: view.panel.current,
				settingsSection: view.panel.settingsSection,
			},
		});
		stage(this.management, view);
		stage(this.dock, view.dock);
		stage(this.transcript, view);
		stage(this.composer, view);
		for (const notify of notifications) notify();
	}
	setConnection(text: ConnectionNotice["text"], kind: "state" | "error"): void {
		if (!this.disposed)
			this.connection.publish({ ...this.connection.getSnapshot(), text, kind });
	}
	setConnectionState(
		text: ConnectionNotice["text"],
		state: ConnectionNotice["state"],
	): void {
		if (!this.disposed) this.connection.publish({ text, state, kind: "state" });
	}
	syncDraft(text: string): void {
		if (!this.disposed) this.pendingDraft = text;
	}
	setDraft(text: string, focus = true): void {
		if (this.disposed) return;
		this.pendingDraft = text;
		this.onDraftChange(text);
		this.draft.publish(text);
		window.dispatchEvent(
			new CustomEvent("amazme:draft-focus", { detail: { text, focus } }),
		);
	}
	insertDraft(text: string, focus = true): void {
		if (!this.disposed)
			window.dispatchEvent(
				new CustomEvent("amazme:draft-insert", { detail: { text, focus } }),
			);
	}
	refreshTranscriptSearch(options?: { readonly loadHistory?: boolean }): void {
		if (!this.disposed)
			window.dispatchEvent(
				new CustomEvent("amazme:transcript-search", { detail: options }),
			);
	}
	attach(unmount: () => void): void {
		if (this.disposed) unmount();
		else this.unmount = unmount;
	}
	dispose(): void {
		this.disposed = true;
		this.unmount?.();
		this.unmount = undefined;
		this.state.clear();
		this.shell.clear();
		this.transcript.clear();
		this.composer.clear();
		this.management.clear();
		this.dock.clear();
		this.draft.clear();
		this.connection.clear();
	}
}
