import * as fs from "node:fs";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.ts";
import { isNativeModifierPressed } from "./native-modifiers.ts";
import { getNativePlatformHelper } from "./native-platform.ts";
import {
	formatProgramStatus,
	isProgramStatusReply,
	PROGRAM_STATUS_QUERY,
	type ProgramStatus,
} from "./program-status.ts";
import { StdinBuffer } from "./stdin-buffer.ts";
import { isStrayTerminalInput } from "./stray-input.ts";
import {
	BRACKETED_PASTE_ON,
	CURSOR_HIDE,
	CURSOR_SHOW,
	KITTY_KEYBOARD_POP,
	MODIFY_OTHER_KEYS_OFF,
	MODIFY_OTHER_KEYS_ON,
	terminalRestoreDefaults,
	terminalRestoreSequence,
	type TerminalModeRestore,
} from "./terminal-restore.ts";
import { replaceControlCharacters } from "./utils.ts";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";
const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u`;
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";

export type KeyboardProtocolNegotiationSequence =
	| { type: "kitty-flags"; flags: number }
	| { type: "device-attributes" };

export function parseKeyboardProtocolNegotiationSequence(
	sequence: string,
): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1]!, 10) };
	}
	if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * Refresh terminal dimensions on POSIX platforms by sending SIGWINCH to this process.
 * Best-effort: some environments (restricted seccomp or LSM policies) return EACCES
 * for `kill(2)`; in that case the dimensions refresh is skipped rather than crashing.
 */
export function refreshTerminalDimensions(): void {
	if (process.platform === "win32" || process.pid <= 0) return;
	try {
		process.kill(process.pid, "SIGWINCH");
	} catch {
		// Signal delivery not permitted in this environment; ignore.
	}
}

function isNativeShiftEnterCandidate(data: string): boolean {
	return data === "\r" || data === "\x1b\r";
}

export function normalizeNativeShiftEnterInput(
	data: string,
	shouldDetectNativeShiftEnter: boolean,
	isShiftPressed: boolean,
): string {
	if (shouldDetectNativeShiftEnter && isNativeShiftEnterCandidate(data) && isShiftPressed) {
		return NATIVE_SHIFT_ENTER_SEQUENCE;
	}
	return data;
}

export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	return normalizeNativeShiftEnterInput(data, isAppleTerminal, isShiftPressed);
}

/** Flush terminal bytes. Falls back to {@link Terminal.write} when no sync write is available. */
export function commitTerminalOutput(terminal: Terminal, data: string): void {
	if (data.length === 0) return;
	if (terminal.writeSync) {
		terminal.writeSync(data);
		return;
	}
	terminal.write(data);
}

export interface TerminalStopOptions {
	/** The caller already wrote {@link terminalRestoreSequence} for this stop. */
	readonly sequenceWritten?: boolean;
	/**
	 * Keep stdin raw after the screen is restored. A shutdown keeps one small consumer so a queued Ctrl-C is read as a
	 * key instead of being echoed as `^C`, then calls {@link Terminal.restoreInput} just before the process exits.
	 */
	readonly deferInputRestore?: boolean;
	/** Bytes read while input restore is deferred. */
	readonly onDeferredInput?: (data: string) => void;
}

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(options?: TerminalStopOptions): void;

	/**
	 * Synchronously restore terminal modes from a process `exit` handler when stop() did not run.
	 * Writes `before`, then this terminal's own mode resets, then `after`.
	 */
	restoreOnExit?(before: string, after: string): void;

	/** Restore cooked input after a stop that deferred it. Idempotent. */
	restoreInput?(): void;

	/**
	 * Modes this terminal turned on, consumed so a later stop does not repeat them.
	 * `TUI.stop` merges the result into {@link terminalRestoreSequence}.
	 */
	takeRestoreModes?(): TerminalModeRestore;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	/**
	 * Write and return only after the bytes are handed to the terminal.
	 * Stop uses this so a following `process.exit` cannot drop the restore.
	 */
	writeSync?(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/**
	 * Report what the program is doing (OSC 7501). Sent only to terminals that support it; the latest
	 * status is re-sent when support is confirmed or the terminal restarts.
	 */
	setProgramStatus(status: ProgramStatus): void;
}

const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;

/**
 * Resolve how long to wait for the rest of an escape sequence before
 * dispatching a lone ESC as the Escape key. Legacy Alt+key input is ESC plus
 * another byte, so high-latency transports need a longer reassembly window.
 */
export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.AMAZME_TUI_ESC_TIMEOUT);
	if (Number.isFinite(configured) && configured > 0) {
		return configured;
	}
	if (env.SSH_CONNECTION || env.SSH_TTY) {
		return DEFAULT_SSH_ESCAPE_TIMEOUT_MS;
	}
	return DEFAULT_ESCAPE_TIMEOUT_MS;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private keyboardProtocolPushed = false;
	/** Set when start() enables bracketed paste, cleared when that mode is given back. */
	private bracketedPasteEnabled = false;
	/** DA1 replies owed to keyboard protocol queries. Later DA1 replies answer other queries and are forwarded. */
	private pendingKeyboardProtocolDeviceAttributes = 0;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	/** Input stays raw until restoreInput(): the shutdown consumer that reads a queued Ctrl-C as a key. */
	private deferredInputHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	/** Latest program status, kept across stop() so start() can report it again. */
	private programStatus?: ProgramStatus;
	/** Whether the terminal confirmed OSC 7501 support since the last start(), or `AMAZME_PROGRAM_STATUS=1`. */
	private programStatusSupported = false;
	/** The support query was sent and its DA1 sentinel has not arrived yet. */
	private programStatusQueryPending = false;
	private writeLogPath = (() => {
		const env = process.env.AMAZME_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this._modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		this.bracketedPasteEnabled = true;
		process.stdout.write(BRACKETED_PASTE_ON);

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only, best-effort.
		refreshTerminalDimensions();

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query Kitty keyboard protocol and fall back to modifyOtherKeys when DA confirms no Kitty response.
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ escapeTimeout: resolveEscapeTimeoutMs() });

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			if (isProgramStatusReply(sequence)) {
				if (this.programStatusQueryPending) {
					this.programStatusQueryPending = false;
					this.programStatusSupported = true;
					this.writeProgramStatus();
				}
				return;
			}
			const negotiation = this.readKeyboardProtocolNegotiationSequence(sequence);
			if (negotiation === "pending") {
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				return; // Wait briefly for the rest of a split Kitty response.
			}
			if (negotiation && this.handleKeyboardProtocolNegotiationSequence(negotiation.parsed)) {
				return;
			}

			const forwarded = negotiation?.sequence ?? sequence;
			// Unsolicited replies belong to no surface; treat them as terminal noise.
			if (isStrayTerminalInput(forwarded)) return;
			this.forwardInputSequence(forwarded);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable it if available.
	 *
	 * Kitty's progressive enhancement detection requires requesting the desired
	 * flags before querying them. The trailing DA query is a sentinel supported by
	 * terminals that do not know Kitty keyboard protocol; receiving DA before a
	 * Kitty response enables modifyOtherKeys fallback without a startup timeout.
	 *
	 * The requested flags are:
	 * - 1 = disambiguate escape codes
	 * - 2 = report event types (press/repeat/release)
	 * - 4 = report alternate keys (shifted key, base layout key)
	 *
	 * The OSC 7501 program status query shares the DA sentinel: a terminal that supports it replies
	 * before DA. `AMAZME_PROGRAM_STATUS=1` or `0` skips the query.
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocolPushed = true;
		this.pendingKeyboardProtocolDeviceAttributes += 1;
		this.clearKeyboardProtocolNegotiationBuffer();
		const programStatusOverride = process.env.AMAZME_PROGRAM_STATUS;
		this.programStatusSupported = programStatusOverride === "1";
		this.programStatusQueryPending = programStatusOverride !== "1" && programStatusOverride !== "0";
		const programStatusQuery = this.programStatusQueryPending ? PROGRAM_STATUS_QUERY : "";
		process.stdout.write(`${KITTY_KEYBOARD_PROTOCOL_QUERY}${programStatusQuery}${DEVICE_ATTRIBUTES_QUERY}`);
		this.writeProgramStatus();
	}

	private handleKeyboardProtocolNegotiationSequence(
		negotiationSequence: KeyboardProtocolNegotiationSequence,
	): boolean {
		this.clearKeyboardProtocolNegotiationBuffer();
		if (negotiationSequence.type === "device-attributes") {
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) return false;
			this.pendingKeyboardProtocolDeviceAttributes -= 1;
			// The last owed DA answers the latest query, which got no program status reply first. Earlier DA
			// replies belong to queries from before a restart.
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) this.programStatusQueryPending = false;
		}
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this._kittyProtocolActive) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this._kittyProtocolActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	/** Returns the parsed negotiation reply with its full (possibly reassembled) sequence. */
	private readKeyboardProtocolNegotiationSequence(
		sequence: string,
	): { parsed: KeyboardProtocolNegotiationSequence; sequence: string } | "pending" | undefined {
		if (this.keyboardProtocolNegotiationBuffer) {
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearKeyboardProtocolNegotiationBuffer();
				return { parsed: negotiationSequence, sequence: bufferedSequence };
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				return "pending";
			}
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return { parsed: negotiationSequence, sequence };
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = "";
	}

	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		if (!this.keyboardProtocolNegotiationBuffer) return;
		const sequence = this.keyboardProtocolNegotiationBuffer;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.forwardInputSequence(sequence);
	}

	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		if (!this.keyboardProtocolBufferFlushTimer) return;
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const shouldDetectNativeShiftEnter =
			isNativeShiftEnterCandidate(sequence) && (isAppleTerminalSession() || process.platform === "win32");
		const input = normalizeNativeShiftEnterInput(
			sequence,
			shouldDetectNativeShiftEnter,
			shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"),
		);
		this.inputHandler(input);
	}

	private enableModifyOtherKeys(): void {
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		process.stdout.write(MODIFY_OTHER_KEYS_ON);
		this._modifyOtherKeysActive = true;
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		this.writeSync(MODIFY_OTHER_KEYS_OFF);
		this._modifyOtherKeysActive = false;
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			getNativePlatformHelper()?.enableVirtualTerminalInput?.();
		} catch {
			// Native helper not available — Shift+Tab won't be distinguishable from Tab.
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (shouldDisableKittyProtocol) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences. Same pop as the shared restore.
			this.writeSync(KITTY_KEYBOARD_POP);
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	takeRestoreModes(): TerminalModeRestore {
		this.clearKeyboardProtocolNegotiationBuffer();
		const modes: TerminalModeRestore = {
			progressClear: this.clearProgressInterval() ? TERMINAL_PROGRESS_CLEAR_SEQUENCE : "",
			programStatusClear:
				this.programStatusSupported && this.programStatus ? formatProgramStatus({ state: "clear" }) : "",
			bracketedPaste: this.bracketedPasteEnabled,
			kittyKeyboard: this.keyboardProtocolPushed || this._kittyProtocolActive,
			modifyOtherKeys: this._modifyOtherKeysActive,
		};
		this.bracketedPasteEnabled = false;
		this.keyboardProtocolPushed = false;
		this._kittyProtocolActive = false;
		setKittyProtocolActive(false);
		this._modifyOtherKeysActive = false;
		this.programStatusSupported = false;
		this.programStatusQueryPending = false;
		return modes;
	}

	restoreOnExit(before: string, after: string): void {
		this.writeSync(
			`${before}${terminalRestoreSequence({ ...terminalRestoreDefaults(), ...this.takeRestoreModes() })}${after}`,
		);
	}

	stop(options?: TerminalStopOptions): void {
		if (!options?.sequenceWritten) {
			this.writeSync(terminalRestoreSequence({ ...terminalRestoreDefaults(), ...this.takeRestoreModes() }));
		}

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		if (options?.deferInputRestore) {
			// Keep raw mode through cleanup. The kernel has not produced a signal for a Ctrl-C already read as a key;
			// restoring cooked mode now would let a queued `\x03` be echoed as `^C` while cleanup still runs.
			const onInput = options.onDeferredInput;
			this.deferredInputHandler = (data: string) => onInput?.(data);
			process.stdin.resume();
			process.stdin.on("data", this.deferredInputHandler);
			return;
		}
		this.restoreInput();
	}

	/** Pause stdin and hand it back to the shell. Called once, at the end of the exit transaction. */
	restoreInput(): void {
		if (this.deferredInputHandler !== undefined) {
			process.stdin.removeListener("data", this.deferredInputHandler);
			this.deferredInputHandler = undefined;
		}
		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		process.stdout.write(data);
		this.appendWriteLog(data);
	}

	writeSync(data: string): void {
		if (data.length === 0) return;
		// `fs.writeSync` may hand the kernel only part of the buffer. A short
		// write must continue, or the tail of an exit sequence never leaves.
		const bytes = Buffer.from(data);
		let offset = 0;
		try {
			while (offset < bytes.length) {
				const written = fs.writeSync(process.stdout.fd, bytes, offset, bytes.length - offset);
				if (written <= 0) break;
				offset += written;
			}
		} catch {
			// Stdout can be gone while the process is exiting. Keep restoring the rest.
		}
		this.appendWriteLog(data);
	}

	private appendWriteLog(data: string): void {
		if (!this.writeLogPath || data.length === 0) return;
		try {
			fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
		} catch {
			// Ignore logging errors
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write(CURSOR_HIDE);
	}

	showCursor(): void {
		process.stdout.write(CURSOR_SHOW);
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		process.stdout.write(`\x1b]0;${replaceControlCharacters(title)}\x07`);
	}

	setProgramStatus(status: ProgramStatus): void {
		this.programStatus = status.state === "clear" ? undefined : status;
		if (this.programStatusSupported) process.stdout.write(formatProgramStatus(status));
	}

	private writeProgramStatus(): void {
		if (this.programStatusSupported && this.programStatus) {
			process.stdout.write(formatProgramStatus(this.programStatus));
		}
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
