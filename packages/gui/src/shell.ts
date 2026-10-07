/**
 * Which host and page failures are errors, and which are the app going away.
 *
 * Closing the window and a normal quit both stop the host. Those exits must not open a
 * dialog. The flag is set at the moment the user asks to leave — the window `close` event,
 * or the start of quit — which is before the child is killed and before the renderer is
 * torn down. A later exit or `render-process-gone` then sees the flag and stays quiet.
 */
import { shouldPresentRenderFailure, type HostFailure, type RenderFailure } from "./dialogs.ts";

export interface HostExitDetail {
	readonly code: number | null;
	readonly signal: string | null;
	readonly tail: string;
}

export interface LoadFailureInput {
	readonly errorCode: number;
	readonly errorDescription: string;
	readonly validatedURL: string;
	readonly isMainFrame: boolean;
}

export interface ShellPorts {
	presentHostFailure(failure: HostFailure): void;
	presentRenderFailure(failure: RenderFailure): void;
}

export interface ShellController {
	/** The user asked the window to close. A host exit after this is expected. */
	userClosedWindow(): void;
	/** Normal quit: the quit path, or the dialog's quit button. A host exit after this is expected. */
	applicationWillQuit(): void;
	readonly quitting: boolean;
	hostExited(detail: HostExitDetail): void;
	startupFailed(failure: HostFailure): void;
	renderProcessGone(details: { readonly reason: string; readonly exitCode: number }): void;
	didFailLoad(input: LoadFailureInput): void;
}

export function createShellController(ports: ShellPorts): ShellController {
	let quitting = false;

	const reportHost = (failure: HostFailure): void => {
		if (quitting) return;
		quitting = true;
		ports.presentHostFailure(failure);
	};

	return {
		userClosedWindow() {
			quitting = true;
		},
		applicationWillQuit() {
			quitting = true;
		},
		get quitting() {
			return quitting;
		},
		hostExited(detail) {
			reportHost({
				kind: "unexpected-exit",
				code: detail.code,
				signal: detail.signal,
				tail: detail.tail,
			});
		},
		startupFailed(failure) {
			reportHost(failure);
		},
		renderProcessGone(details) {
			const failure: RenderFailure = {
				kind: "render-process-gone",
				reason: details.reason,
				exitCode: details.exitCode,
			};
			if (!shouldPresentRenderFailure(quitting, failure)) return;
			ports.presentRenderFailure(failure);
		},
		didFailLoad(input) {
			const failure: RenderFailure = { kind: "did-fail-load", ...input };
			if (!shouldPresentRenderFailure(quitting, failure)) return;
			ports.presentRenderFailure(failure);
		},
	};
}
