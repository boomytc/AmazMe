import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import type { Terminal, TerminalStopOptions } from "../src/terminal.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import {
	terminalRestoreDefaults,
	terminalRestoreSequence,
	type TerminalModeRestore,
} from "../src/terminal-restore.ts";

const openedModes: TerminalModeRestore = {
	progressClear: "\x1b]9;4;0\x07",
	programStatusClear: "\x1b]7501;state=clear\x1b\\",
	bracketedPaste: true,
	kittyKeyboard: true,
	modifyOtherKeys: true,
};

class SyncTerminal implements Terminal {
	readonly asyncWrites: string[] = [];
	readonly syncWrites: string[] = [];
	stopped = false;
	readonly columns = 20;
	readonly rows = 4;
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
			return {
				progressClear: "",
				programStatusClear: "",
				bracketedPaste: false,
				kittyKeyboard: false,
				modifyOtherKeys: false,
			};
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

function fullscreenRestore(): string {
	return terminalRestoreSequence({
		...terminalRestoreDefaults(),
		...openedModes,
		showCursor: true,
		altScreen: true,
		mouse: true,
		preserveScreen: true,
	});
}

describe("TUI stop flush", () => {
	it("writes the shared restore sequence synchronously and does not reprint the frame", () => {
		const terminal = new SyncTerminal();
		const tui = new TuiAltScreen(terminal, false);
		tui.addChild(new Text("FRAME_MARKER", 0, 0));
		tui.start();
		tui.renderNow(true);
		const asyncBeforeStop = terminal.asyncWrites.length;

		tui.stop({ preserveScreen: true });

		const synced = terminal.syncWrites.join("");
		assert.equal(terminal.stopped, true);
		assert.equal(synced, fullscreenRestore());
		assert.equal(terminal.asyncWrites.slice(asyncBeforeStop).join("").includes("\x1b[?1049l"), false);
		assert.equal(synced.includes("FRAME_MARKER"), false);
	});

	it("names every mode the start path can enable", () => {
		const sequence = terminalRestoreSequence({
			...terminalRestoreDefaults(),
			...openedModes,
			colorSchemeOff: "\x1b[?2031l",
			showCursor: true,
			altScreen: true,
			mouse: true,
			preserveScreen: true,
		});
		for (const piece of [
			"\x1b[?2031l",
			"\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
			"\x1b[?7h",
			"\x1b[?25h",
			"\x1b]9;4;0\x07",
			"\x1b]7501;state=clear\x1b\\",
			"\x1b[?2004l",
			"\x1b[<u",
			"\x1b[>4;0m",
			"\x1b[?1049l",
			"\r\n",
		]) {
			assert.equal(sequence.includes(piece), true, piece);
		}
	});
});
