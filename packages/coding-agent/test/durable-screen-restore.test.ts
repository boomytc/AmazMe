import {
	resetCapabilitiesCache,
	setCapabilities,
	StdinBuffer,
	Text,
	type Terminal,
	type TerminalModeRestore,
	type TerminalStopOptions,
	terminalRestoreDefaults,
	terminalRestoreSequence,
	TuiAltScreen,
	TuiMainScreen,
} from "@amazme/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreDurableScreen } from "../src/durable/screen-restore.ts";
import {
	installShutdownSignals,
	setShutdownTerminalRestore,
	SHUTDOWN_FORCE_EXIT_CODE,
	SHUTDOWN_FORCE_EXIT_MESSAGE,
	shutdownExit,
} from "../src/utils/shutdown-signals.ts";

const openedModes: TerminalModeRestore = {
	progressClear: "",
	programStatusClear: "",
	bracketedPaste: true,
	kittyKeyboard: true,
	modifyOtherKeys: true,
};

class SyncTerminal implements Terminal {
	readonly asyncWrites: string[] = [];
	readonly syncWrites: string[] = [];
	stopped = false;
	readonly columns = 40;
	readonly rows = 8;
	readonly kittyProtocolActive = false;
	private modesTaken = false;

	start(): void {}
	stop(options?: TerminalStopOptions): void {
		this.stopped = true;
		if (!options?.sequenceWritten) {
			this.writeSync(terminalRestoreSequence({ ...terminalRestoreDefaults(), ...this.takeRestoreModes() }));
		}
	}
	takeRestoreModes(): TerminalModeRestore {
		if (this.modesTaken) {
			return { progressClear: "", programStatusClear: "", bracketedPaste: false, kittyKeyboard: false, modifyOtherKeys: false };
		}
		this.modesTaken = true;
		return openedModes;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.asyncWrites.push(data);
	}
	writeSync(data: string): void {
		this.syncWrites.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

function fullscreenStopSequence(mouse: boolean): string {
	return terminalRestoreSequence({
		...terminalRestoreDefaults(),
		...openedModes,
		showCursor: true,
		altScreen: true,
		mouse,
		preserveScreen: true,
	});
}

function captureAlt(mouse: boolean, stop: (ui: TuiAltScreen) => void): string {
	const terminal = new SyncTerminal();
	const ui = new TuiAltScreen(terminal, false, undefined, { mouse });
	ui.addChild(new Text("FRAME_MARKER", 0, 0));
	ui.start();
	ui.renderNow(true);
	const start = terminal.syncWrites.length;
	stop(ui);
	return terminal.syncWrites.slice(start).join("");
}

describe("durable screen restore", () => {
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		// The host terminal's image protocol must not decide the expected restore sequence (Warp, for example,
		// advertises Kitty and would add an image-delete escape).
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	});

	afterEach(() => {
		resetCapabilitiesCache();
		for (const cleanup of cleanups.splice(0)) cleanup();
		setShutdownTerminalRestore(undefined);
	});

	it("leaves the alternate screen without reprinting the last frame", () => {
		const terminal = new SyncTerminal();
		const ui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
		ui.addChild(new Text("FRAME_MARKER", 0, 0));
		ui.start();
		ui.renderNow(true);

		restoreDurableScreen(ui);
		restoreDurableScreen(ui);

		const synced = terminal.syncWrites.join("");
		expect(terminal.stopped).toBe(true);
		expect(synced).toBe(fullscreenStopSequence(false));
		expect(synced).toBe(captureAlt(false, (other) => other.stop({ preserveScreen: true })));
		expect(synced).not.toContain("FRAME_MARKER");
		expect(synced.match(/\r\n/g)).toEqual(["\r\n"]);
	});

	it("keeps regular-mode conversation text and parks the cursor under it", () => {
		const terminal = new SyncTerminal();
		const ui = new TuiMainScreen(terminal, false);
		ui.addChild(new Text("KEEP_CONVERSATION", 0, 0));
		ui.start();
		ui.renderNow(true);

		restoreDurableScreen(ui);

		const twin = new SyncTerminal();
		const other = new TuiMainScreen(twin, false);
		other.addChild(new Text("KEEP_CONVERSATION", 0, 0));
		other.start();
		other.renderNow(true);
		other.stop();

		const synced = terminal.syncWrites.join("");
		expect(synced).toBe(twin.syncWrites.join(""));
		expect(terminal.asyncWrites.join("")).toContain("KEEP_CONVERSATION");
		expect(synced).not.toContain("\x1b[?1049l");
		expect(synced).not.toContain("\x1b[2J");
		expect(synced).toContain("\r\n");
		expect(synced).toContain("\x1b[?2004l");
		expect(synced).toContain("\x1b[<u");
		expect(synced).toContain("\x1b[>4;0m");
	});

	it("writes the same restore sequence as a normal stop, synchronously, before the force-exit line", () => {
		const normal = captureAlt(true, (ui) => ui.stop({ preserveScreen: true }));
		expect(normal).toBe(fullscreenStopSequence(true));

		const events: string[] = [];
		const terminal = new SyncTerminal();
		const ui = new TuiAltScreen(terminal, false);
		ui.addChild(new Text("FRAME_MARKER", 0, 0));
		ui.start();
		ui.renderNow(true);
		terminal.writeSync = (data: string) => {
			terminal.syncWrites.push(data);
			events.push(`stdout:${data}`);
		};

		const shutdown = installShutdownSignals(() => {
			events.push("signal");
		});
		cleanups.push(() => shutdown.dispose());
		setShutdownTerminalRestore(() => {
			events.push("restore");
			restoreDurableScreen(ui);
		});

		const previousWriteStderr = shutdownExit.writeStderr;
		const previousExit = shutdownExit.exit;
		shutdownExit.writeStderr = (text: string) => {
			events.push(`stderr:${text}`);
		};
		shutdownExit.exit = ((code: number) => {
			events.push(`exit:${String(code)}`);
			throw new Error(`exit ${String(code)}`);
		}) as typeof shutdownExit.exit;
		cleanups.push(() => {
			shutdownExit.writeStderr = previousWriteStderr;
			shutdownExit.exit = previousExit;
		});

		const buffer = new StdinBuffer();
		buffer.on("data", (sequence) => {
			if (sequence !== "\x03") return;
			shutdown.key(() => {
				events.push("first-key");
			});
		});

		expect(() => buffer.process("\x03\x03")).toThrow(`exit ${SHUTDOWN_FORCE_EXIT_CODE}`);

		const firstKey = events.indexOf("first-key");
		const restore = events.indexOf("restore");
		const stdoutIndexes = events.flatMap((event, index) => (event.startsWith("stdout:") ? [index] : []));
		const stderr = events.findIndex((event) => event.startsWith("stderr:"));
		const exit = events.indexOf(`exit:${SHUTDOWN_FORCE_EXIT_CODE}`);
		const forceBytes = stdoutIndexes.map((index) => events[index]?.slice("stdout:".length) ?? "").join("");
		expect(firstKey).toBeGreaterThanOrEqual(0);
		expect(restore).toBeGreaterThan(firstKey);
		expect(stdoutIndexes.length).toBeGreaterThan(0);
		expect(stdoutIndexes[0]).toBeGreaterThan(restore);
		expect(Math.max(...stdoutIndexes)).toBeLessThan(stderr);
		expect(exit).toBeGreaterThan(stderr);
		expect(forceBytes).toBe(normal);
		expect(forceBytes.endsWith("\r\n")).toBe(true);
		expect(events[stderr]).toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
		expect(forceBytes).not.toContain("FRAME_MARKER");
		expect(events).not.toContain("signal");
		expect(terminal.stopped).toBe(true);
	});
});
