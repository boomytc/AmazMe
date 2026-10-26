export type CloseWindowPreference = "background" | "quit";

export interface DesktopPreferences {
	readonly closeWindow: CloseWindowPreference;
	readonly closeWindowPrompt: boolean;
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
	closeWindow: "background",
	closeWindowPrompt: true,
};

export interface CloseConfirmation {
	readonly choice: "background" | "quit" | "cancel";
	readonly remember: boolean;
}

export type LifecyclePhase = "open" | "checking" | "asking-close" | "asking-quit" | "closing" | "quitting" | "failed" | "exited";
export type LifecycleError = "activity" | "preferences" | "cleanup";

export interface LifecyclePorts<Window> {
	readPreferences(): Promise<DesktopPreferences>;
	readActivity(): Promise<{ readonly active: boolean }>;
	savePreferences(value: DesktopPreferences): Promise<void>;
	confirmClose(target: Window): Promise<CloseConfirmation>;
	confirmQuit(): Promise<boolean>;
	reportError(kind: LifecycleError): Promise<boolean>;
	hideWindow(target: Window): void;
	applicationWillQuit(): void;
	cleanup(): Promise<void>;
	releaseQuit(): void;
}

export interface DesktopLifecycle<Window> {
	readonly phase: LifecyclePhase;
	readonly quitting: boolean;
	requestClose(target: Window): Promise<void>;
	requestQuit(): Promise<void>;
	quitImmediately(): Promise<void>;
	allowQuit(): boolean;
}

type Intent = "close" | "quit" | "cleanup";
type Step = "done" | "retry";

export function createDesktopLifecycle<Window>(ports: LifecyclePorts<Window>): DesktopLifecycle<Window> {
	let phase: LifecyclePhase = "open";
	let operation: Promise<void> | undefined;
	let pending: "quit" | "cleanup" | undefined;
	let cleanupStarted = false;
	let quitNotified = false;

	const report = async (kind: LifecycleError): Promise<Step> => {
		phase = "failed";
		const retry = await ports.reportError(kind);
		if (retry) return "retry";
		phase = "open";
		return "done";
	};

	const save = async (value: DesktopPreferences): Promise<Step | "cancel"> => {
		try {
			await ports.savePreferences(value);
			return "done";
		} catch {
			return (await report("preferences")) === "retry" ? "retry" : "cancel";
		}
	};

	const cleanup = async (): Promise<"done"> => {
		for (;;) {
			phase = "quitting";
			cleanupStarted = true;
			if (!quitNotified) {
				quitNotified = true;
				ports.applicationWillQuit();
			}
			try {
				await ports.cleanup();
				phase = "exited";
				ports.releaseQuit();
				return "done";
			} catch {
				if (await report("cleanup") === "done") return "done";
			}
		}
	};

	const takePending = (): Intent | undefined => {
		const value = pending;
		pending = undefined;
		return value;
	};

	const close = async (target: Window): Promise<"done" | Intent> => {
		if (cleanupStarted) return "cleanup";
		let preferences: DesktopPreferences;
		let active: boolean;
		phase = "checking";
		try {
			preferences = await ports.readPreferences();
		} catch {
			return (await report("preferences")) === "retry" ? "close" : "done";
		}
		try {
			active = (await ports.readActivity()).active;
		} catch {
			return (await report("activity")) === "retry" ? "close" : "done";
		}
		const beforePrompt = takePending();
		if (beforePrompt !== undefined) return beforePrompt;
		let action = preferences.closeWindow;
		let remember = false;
		if (active && preferences.closeWindowPrompt) {
			phase = "asking-close";
			const confirmation = await ports.confirmClose(target);
			const promoted = takePending();
			if (promoted !== undefined) {
				if (promoted === "cleanup" || confirmation.choice === "quit") return "cleanup";
				return "quit";
			}
			if (confirmation.choice === "cancel") {
				phase = "open";
				return "done";
			}
			action = confirmation.choice;
			remember = confirmation.remember;
		}
		if (remember) {
			const saved = await save({ closeWindow: action, closeWindowPrompt: false });
			if (saved === "retry") return "close";
			if (saved === "cancel") return "done";
		}
		const beforeAction = takePending();
		if (beforeAction !== undefined) {
			if (beforeAction === "cleanup" || action === "quit") return "cleanup";
			return "quit";
		}
		if (action === "quit") return "cleanup";
		phase = "closing";
		ports.hideWindow(target);
		phase = "open";
		return "done";
	};

	const quit = async (): Promise<"done" | Intent> => {
		if (cleanupStarted) return "cleanup";
		phase = "checking";
		try {
			if ((await ports.readActivity()).active) {
				phase = "asking-quit";
				if (!await ports.confirmQuit()) {
					phase = "open";
					return "done";
				}
			}
		} catch {
			return (await report("activity")) === "retry" ? "quit" : "done";
		}
		return "cleanup";
	};

	const start = (initial: Intent, closeTarget?: Window): Promise<void> => {
		if (operation !== undefined) return operation;
		operation = (async () => {
			let intent = initial;
			for (;;) {
				if (intent === "close" && closeTarget === undefined) throw new Error("desktop close target is missing");
				const next = intent === "close" ? await close(closeTarget as Window) : intent === "quit" ? await quit() : await cleanup();
				if (pending !== undefined && phase !== "exited") {
					intent = pending;
					pending = undefined;
					continue;
				}
				if (next === "done") return;
				intent = next;
			}
		})().finally(() => {
			operation = undefined;
		});
		return operation;
	};

	return {
		get phase() { return phase; },
		get quitting() { return cleanupStarted; },
		requestClose(target) {
			if (phase === "exited") return Promise.resolve();
			return start("close", target);
		},
		requestQuit() {
			if (phase === "exited") return Promise.resolve();
			if (operation !== undefined) {
				if (phase !== "asking-quit" && pending !== "cleanup") pending = "quit";
				return operation;
			}
			return start("quit");
		},
		quitImmediately() {
			if (phase === "exited") return Promise.resolve();
			if (operation !== undefined) {
				pending = "cleanup";
				return operation;
			}
			return start("cleanup");
		},
		allowQuit() { return phase === "exited"; },
	};
}
