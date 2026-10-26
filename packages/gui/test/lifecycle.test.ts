import { describe, expect, test, vi } from "vitest";
import {
	createDesktopLifecycle,
	DEFAULT_DESKTOP_PREFERENCES,
	type CloseConfirmation,
	type DesktopPreferences,
	type LifecycleError,
} from "../src/lifecycle.ts";

interface Store {
	preferences: DesktopPreferences;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function fixture(store: Store = { preferences: { ...DEFAULT_DESKTOP_PREFERENCES } }) {
	const state = {
		active: false,
		closeAnswers: [] as CloseConfirmation[],
		quitAnswers: [] as boolean[],
		errorAnswers: [] as boolean[],
		hidden: [] as string[],
		errors: [] as LifecycleError[],
		saved: [] as DesktopPreferences[],
	};
	const readPreferences = vi.fn(async () => ({ ...store.preferences }));
	const readActivity = vi.fn(async () => ({ active: state.active }));
	const savePreferences = vi.fn(async (value: DesktopPreferences) => {
		store.preferences = { ...value };
		state.saved.push(value);
	});
	const confirmClose = vi.fn(async (_target: string) => state.closeAnswers.shift() ?? { choice: "cancel" as const, remember: false });
	const confirmQuit = vi.fn(async () => state.quitAnswers.shift() ?? false);
	const reportError = vi.fn(async (kind: LifecycleError) => {
		state.errors.push(kind);
		return state.errorAnswers.shift() ?? false;
	});
	const hideWindow = vi.fn((target: string) => { state.hidden.push(target); });
	const applicationWillQuit = vi.fn();
	const cleanup = vi.fn(async () => {});
	const releaseQuit = vi.fn();
	const lifecycle = createDesktopLifecycle<string>({
		readPreferences, readActivity, savePreferences, confirmClose, confirmQuit, reportError,
		hideWindow, applicationWillQuit, cleanup, releaseQuit,
	});
	return { state, store, lifecycle, readPreferences, readActivity, savePreferences, confirmClose, confirmQuit, reportError, hideWindow, applicationWillQuit, cleanup, releaseQuit };
}

describe("desktop close preferences", () => {
	test.each([
		{ closeWindow: "background" as const, hidden: 1, cleanups: 0 },
		{ closeWindow: "quit" as const, hidden: 0, cleanups: 1 },
	])("an idle close follows $closeWindow without a task prompt", async ({ closeWindow, hidden, cleanups }) => {
		const f = fixture({ preferences: { closeWindow, closeWindowPrompt: true } });
		await f.lifecycle.requestClose("main");
		expect(f.state.hidden).toHaveLength(hidden);
		expect(f.cleanup).toHaveBeenCalledTimes(cleanups);
		expect(f.releaseQuit).toHaveBeenCalledTimes(cleanups);
		expect(f.confirmClose).not.toHaveBeenCalled();
		expect(f.confirmQuit).not.toHaveBeenCalled();
	});

	test("background, stop-and-quit, and cancel have distinct effects", async () => {
		const background = fixture();
		background.state.active = true;
		background.state.closeAnswers.push({ choice: "background", remember: false });
		await background.lifecycle.requestClose("main");
		expect(background.state.hidden).toEqual(["main"]);
		expect(background.cleanup).not.toHaveBeenCalled();

		const quit = fixture();
		quit.state.active = true;
		quit.state.closeAnswers.push({ choice: "quit", remember: false });
		await quit.lifecycle.requestClose("main");
		expect(quit.cleanup).toHaveBeenCalledTimes(1);
		expect(quit.releaseQuit).toHaveBeenCalledTimes(1);
		expect(quit.state.hidden).toEqual([]);

		const cancel = fixture();
		cancel.state.active = true;
		cancel.state.closeAnswers.push({ choice: "cancel", remember: true });
		await cancel.lifecycle.requestClose("main");
		expect(cancel.state.hidden).toEqual([]);
		expect(cancel.cleanup).not.toHaveBeenCalled();
		expect(cancel.savePreferences).not.toHaveBeenCalled();
		expect(cancel.lifecycle.phase).toBe("open");
	});

	test.each(["background", "quit"] as const)("remembering %s persists across a new lifecycle and suppresses the next prompt", async choice => {
		const store: Store = { preferences: { ...DEFAULT_DESKTOP_PREFERENCES } };
		const first = fixture(store);
		first.state.active = true;
		first.state.closeAnswers.push({ choice, remember: true });
		await first.lifecycle.requestClose("main");
		expect(store.preferences).toEqual({ closeWindow: choice, closeWindowPrompt: false });

		const restarted = fixture(store);
		restarted.state.active = true;
		await restarted.lifecycle.requestClose("main");
		expect(restarted.confirmClose).not.toHaveBeenCalled();
		expect(restarted.readActivity).toHaveBeenCalledTimes(1);
		if (choice === "background") expect(restarted.state.hidden).toEqual(["main"]);
		else expect(restarted.cleanup).toHaveBeenCalledTimes(1);
	});

	test("a failed remembered save leaves the window, tasks, and stored preference unchanged", async () => {
		const f = fixture();
		f.state.active = true;
		f.savePreferences.mockRejectedValueOnce(new Error("revision conflict"));
		f.state.closeAnswers.push({ choice: "quit", remember: true });
		await f.lifecycle.requestClose("main");
		expect(f.state.hidden).toEqual([]);
		expect(f.cleanup).not.toHaveBeenCalled();
		expect(f.store.preferences).toEqual(DEFAULT_DESKTOP_PREFERENCES);
		expect(f.state.errors).toEqual(["preferences"]);
	});

	test("not remembering keeps the prompt enabled for the next active close", async () => {
		const f = fixture();
		f.state.active = true;
		f.state.closeAnswers.push({ choice: "background", remember: false }, { choice: "cancel", remember: false });
		await f.lifecycle.requestClose("main");
		await f.lifecycle.requestClose("main");
		expect(f.confirmClose).toHaveBeenCalledTimes(2);
		expect(f.store.preferences.closeWindowPrompt).toBe(true);
	});
});

describe("explicit quit and lifecycle races", () => {
	test("Cmd-Q is an exit intent even when close prefers background", async () => {
		const f = fixture();
		await f.lifecycle.requestQuit();
		expect(f.cleanup).toHaveBeenCalledTimes(1);
		expect(f.confirmClose).not.toHaveBeenCalled();
		expect(f.confirmQuit).not.toHaveBeenCalled();
	});

	test("an active explicit quit can be cancelled and then retried without changing close preferences", async () => {
		const f = fixture();
		f.state.active = true;
		f.state.quitAnswers.push(false, true);
		await f.lifecycle.requestQuit();
		expect(f.cleanup).not.toHaveBeenCalled();
		expect(f.lifecycle.phase).toBe("open");
		expect(f.store.preferences).toEqual(DEFAULT_DESKTOP_PREFERENCES);
		await f.lifecycle.requestQuit();
		expect(f.cleanup).toHaveBeenCalledTimes(1);
		expect(f.savePreferences).not.toHaveBeenCalled();
	});

	test("a task finishing during the close prompt does not turn background into cancellation", async () => {
		const f = fixture();
		const answer = deferred<CloseConfirmation>();
		f.confirmClose.mockReturnValueOnce(answer.promise);
		f.state.active = true;
		const closing = f.lifecycle.requestClose("main");
		await flush();
		f.state.active = false;
		answer.resolve({ choice: "background", remember: false });
		await closing;
		expect(f.state.hidden).toEqual(["main"]);
		expect(f.cleanup).not.toHaveBeenCalled();
	});

	test("a task arriving during the prompt is covered by the confirmed quit cleanup", async () => {
		const f = fixture();
		const answer = deferred<CloseConfirmation>();
		f.confirmClose.mockReturnValueOnce(answer.promise);
		f.state.active = true;
		const closing = f.lifecycle.requestClose("main");
		await flush();
		f.state.active = true;
		answer.resolve({ choice: "quit", remember: false });
		await closing;
		expect(f.cleanup).toHaveBeenCalledTimes(1);
	});

	test("an activity failure keeps the window and can be retried", async () => {
		const f = fixture();
		f.readActivity.mockRejectedValueOnce(new Error("offline"));
		f.state.errorAnswers.push(true);
		await f.lifecycle.requestClose("main");
		expect(f.state.errors).toEqual(["activity"]);
		expect(f.state.hidden).toEqual(["main"]);
		expect(f.cleanup).not.toHaveBeenCalled();

		const kept = fixture();
		kept.readActivity.mockRejectedValueOnce(new Error("offline"));
		await kept.lifecycle.requestClose("main");
		expect(kept.state.hidden).toEqual([]);
		expect(kept.cleanup).not.toHaveBeenCalled();
		expect(kept.lifecycle.phase).toBe("open");
	});

	test("repeated close and Cmd-Q share one close prompt and never hide before a cancelled quit", async () => {
		const f = fixture();
		const answer = deferred<CloseConfirmation>();
		f.confirmClose.mockReturnValueOnce(answer.promise);
		f.state.active = true;
		f.state.quitAnswers.push(false);
		const first = f.lifecycle.requestClose("main");
		const second = f.lifecycle.requestClose("main");
		await flush();
		expect(f.confirmClose).toHaveBeenCalledTimes(1);
		const quitting = f.lifecycle.requestQuit();
		answer.resolve({ choice: "background", remember: true });
		await Promise.all([first, second, quitting]);
		expect(f.confirmQuit).toHaveBeenCalledTimes(1);
		expect(f.state.hidden).toEqual([]);
		expect(f.cleanup).not.toHaveBeenCalled();
		expect(f.savePreferences).not.toHaveBeenCalled();
	});

	test("Cmd-Q during its own confirmation does not open another confirmation", async () => {
		const f = fixture();
		const answer = deferred<boolean>();
		f.confirmQuit.mockReturnValueOnce(answer.promise);
		f.state.active = true;
		const quitting = f.lifecycle.requestQuit();
		await flush();
		const repeated = f.lifecycle.requestQuit();
		answer.resolve(false);
		await Promise.all([quitting, repeated]);
		expect(f.confirmQuit).toHaveBeenCalledTimes(1);
		expect(f.cleanup).not.toHaveBeenCalled();
	});

	test("cleanup failure is explicit and retry does not repeat task confirmation", async () => {
		const f = fixture({ preferences: { closeWindow: "quit", closeWindowPrompt: true } });
		f.cleanup.mockRejectedValueOnce(new Error("timeout"));
		f.state.errorAnswers.push(true);
		await f.lifecycle.requestClose("main");
		expect(f.state.errors).toEqual(["cleanup"]);
		expect(f.cleanup).toHaveBeenCalledTimes(2);
		expect(f.releaseQuit).toHaveBeenCalledTimes(1);
		expect(f.applicationWillQuit).toHaveBeenCalledTimes(1);
	});

	test("a later quit retries failed cleanup without re-querying or re-cancelling from another entry", async () => {
		const f = fixture();
		f.cleanup.mockRejectedValueOnce(new Error("timeout"));
		await f.lifecycle.requestQuit();
		expect(f.releaseQuit).not.toHaveBeenCalled();
		expect(f.lifecycle.phase).toBe("open");
		const reads = f.readActivity.mock.calls.length;
		await f.lifecycle.requestQuit();
		expect(f.readActivity).toHaveBeenCalledTimes(reads);
		expect(f.cleanup).toHaveBeenCalledTimes(2);
		expect(f.releaseQuit).toHaveBeenCalledTimes(1);
	});
});
