/**
 * Which host and page failures are errors, and which are the app going away.
 * Hiding a window does not set this flag. Only an actual quit or an unrecoverable host failure
 * suppresses the renderer and child-exit diagnostics that follow teardown.
 */
import { shouldPresentRenderFailure, type HostFailure, type RenderFailure } from "./dialogs.ts";
import type { HostExitDetail } from "./host.ts";

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
