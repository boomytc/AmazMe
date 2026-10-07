/**
 * Failure dialogs for the page process and the web-host child.
 *
 * Titles, bodies, and button labels are assembled here from the page catalog (`desktop.*`). The
 * main process only shows the result. The reload button loads the host address again; the other
 * button quits.
 */
import type { Locale } from "@amazme/web/locale";
import { translate, type MessageKey } from "@amazme/web/strings";

/** Chromium `net::ERR_ABORTED`. A load the page itself replaced, or a window tearing down. */
const ERR_ABORTED = -3;

/** How many trailing output lines a host dialog keeps. The supervisor's buffer is the other bound. */
export const HOST_DIALOG_TAIL_LINES = 12;

/** Cap on the tail actually placed in the dialog, so one long line cannot fill the box. */
export const HOST_DIALOG_TAIL_CHARS = 4_000;

const RENDER_REASONS = {
	"clean-exit": "desktop.render.reason.clean-exit",
	"abnormal-exit": "desktop.render.reason.abnormal-exit",
	killed: "desktop.render.reason.killed",
	crashed: "desktop.render.reason.crashed",
	oom: "desktop.render.reason.oom",
	"launch-failed": "desktop.render.reason.launch-failed",
	"integrity-failure": "desktop.render.reason.integrity-failure",
	"memory-eviction": "desktop.render.reason.memory-eviction",
} as const satisfies Record<string, MessageKey>;

export type RenderFailure =
	| {
			readonly kind: "render-process-gone";
			readonly reason: string;
			readonly exitCode: number;
	  }
	| {
			readonly kind: "did-fail-load";
			readonly isMainFrame: boolean;
			readonly errorCode: number;
			readonly errorDescription: string;
			readonly validatedURL: string;
	  };

/**
 * A host failure the dialog can explain. `message` is the supervisor's own sentence for
 * failures that are not an exit code. `tail` is the raw bounded stdout/stderr buffer.
 */
export type HostFailure =
	| {
			readonly kind: "spawn-error" | "readiness-timeout" | "invalid-output" | "startup-error";
			readonly message: string;
			readonly tail: string;
	  }
	| {
			readonly kind: "exit-before-ready";
			readonly message: string;
			readonly code: number | null;
			readonly signal: string | null;
			readonly tail: string;
	  }
	| {
			readonly kind: "unexpected-exit";
			readonly code: number | null;
			readonly signal: string | null;
			readonly tail: string;
	  };

export interface RenderDialogCopy {
	readonly title: string;
	readonly message: string;
	readonly detail: string;
	/** Index 0 loads the host address again. Index 1 quits the app. */
	readonly buttons: readonly [string, string];
}

export interface HostDialogCopy {
	readonly title: string;
	readonly message: string;
	readonly detail: string;
	/** The only button quits the app. The dialog has already decided the host is gone. */
	readonly buttons: readonly [string];
}

export type RenderDialogRecovery = { readonly kind: "load"; readonly url: string } | { readonly kind: "quit" };

/**
 * What the reload button does. Index 0 loads `hostUrl` with `loadURL`. `webContents.reload()` is
 * not used: a first load that never committed has no document to reload, so it would not come
 * back to the host. Any other button, a quit already in progress, or a missing host address leaves.
 */
export function renderDialogRecovery(
	response: number,
	quitting: boolean,
	hostUrl: string | undefined,
): RenderDialogRecovery {
	if (response === 0 && !quitting && hostUrl !== undefined && hostUrl.length > 0) {
		return { kind: "load", url: hostUrl };
	}
	return { kind: "quit" };
}

/** A load the user or the page aborted, not a failure worth a dialog. */
export function isIntentionalLoadAbort(errorCode: number, errorDescription: string): boolean {
	return errorCode === ERR_ABORTED || errorDescription === "ERR_ABORTED";
}

/**
 * Whether this renderer event should open the reload/quit dialog. Quitting wins: closing
 * the window and a normal app quit both tear the page down, and that is not a failure.
 * Subframes and aborted loads are ignored even while the app is running.
 */
export function shouldPresentRenderFailure(quitting: boolean, failure: RenderFailure): boolean {
	if (quitting) return false;
	if (failure.kind === "render-process-gone") return true;
	if (!failure.isMainFrame) return false;
	return !isIntentionalLoadAbort(failure.errorCode, failure.errorDescription);
}

/** The trailing lines of a host output buffer, empty when the child produced nothing. */
export function visibleOutputTail(tail: string): string {
	const normalized = tail.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
	if (normalized.length === 0) return "";
	const lines = normalized.split("\n");
	const kept = lines.slice(-HOST_DIALOG_TAIL_LINES);
	let omitted = kept.length < lines.length;
	let body = kept.join("\n");
	if (body.length > HOST_DIALOG_TAIL_CHARS) {
		body = body.slice(-HOST_DIALOG_TAIL_CHARS);
		omitted = true;
	}
	return omitted ? `...\n${body}` : body;
}

function renderReason(locale: Locale, reason: string): string {
	const key = RENDER_REASONS[reason as keyof typeof RENDER_REASONS];
	return key === undefined ? reason : translate(locale, key);
}

function shownCode(locale: Locale, code: number | null): string {
	return code === null ? translate(locale, "desktop.host.none") : String(code);
}

function shownSignal(locale: Locale, signal: string | null): string {
	return signal === null || signal.length === 0 ? translate(locale, "desktop.host.none") : signal;
}

/** Reload / quit copy for a page-process failure. `detail` is the URL, or empty. */
export function renderFailureCopy(locale: Locale, failure: RenderFailure): RenderDialogCopy {
	const buttons = [translate(locale, "desktop.dialog.reload"), translate(locale, "desktop.dialog.quit")] as const;
	if (failure.kind === "render-process-gone") {
		return {
			title: translate(locale, "desktop.render.gone.title"),
			message: translate(locale, "desktop.render.gone.message", {
				reason: renderReason(locale, failure.reason),
				exitCode: String(failure.exitCode),
			}),
			detail: "",
			buttons,
		};
	}
	return {
		title: translate(locale, "desktop.render.load.title"),
		message: translate(locale, "desktop.render.load.message", {
			errorCode: String(failure.errorCode),
			errorDescription: failure.errorDescription,
		}),
		detail: failure.validatedURL,
		buttons,
	};
}

function hostCopy(
	locale: Locale,
	titleKey: MessageKey,
	messageKey: MessageKey,
	values: Record<string, string> | undefined,
	tail: string,
): HostDialogCopy {
	const visible = visibleOutputTail(tail);
	return {
		title: translate(locale, titleKey),
		message: translate(locale, messageKey, values),
		detail: visible.length > 0 ? visible : translate(locale, "desktop.host.noOutput"),
		buttons: [translate(locale, "desktop.dialog.quit")],
	};
}

/** Quit-only copy for a host failure, including the trailing stdout/stderr when there is any. */
export function hostFailureCopy(locale: Locale, failure: HostFailure): HostDialogCopy {
	switch (failure.kind) {
		case "spawn-error":
			return hostCopy(
				locale,
				"desktop.host.spawn.title",
				"desktop.host.spawn.message",
				{ message: failure.message },
				failure.tail,
			);
		case "exit-before-ready":
			return hostCopy(
				locale,
				"desktop.host.early.title",
				"desktop.host.early.message",
				{ code: shownCode(locale, failure.code), signal: shownSignal(locale, failure.signal) },
				failure.tail,
			);
		case "readiness-timeout":
			return hostCopy(
				locale,
				"desktop.host.timeout.title",
				"desktop.host.timeout.message",
				{ message: failure.message },
				failure.tail,
			);
		case "invalid-output":
		case "startup-error":
			return hostCopy(
				locale,
				"desktop.host.invalid.title",
				"desktop.host.invalid.message",
				{ message: failure.message },
				failure.tail,
			);
		case "unexpected-exit":
			return hostCopy(
				locale,
				"desktop.host.crashed.title",
				"desktop.host.crashed.message",
				{ code: shownCode(locale, failure.code), signal: shownSignal(locale, failure.signal) },
				failure.tail,
			);
		default: {
			const exhaustive: never = failure;
			return exhaustive;
		}
	}
}
