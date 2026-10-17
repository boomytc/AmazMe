/**
 * Terminal chatter that is never a keypress.
 *
 * Terminals and multiplexers emit these replies on their own: legacy X10 mouse
 * reports from a wrapper that ignored SGR, device-attribute replies, cursor-position
 * reports, mode reports, and DCS strings such as XTVERSION. Nothing in the TUI consumes
 * them, and letting one through used to paste escape bytes into the editor. Device
 * attributes stay forwarded: the color query uses DA1 as its terminator.
 */

const X10_MOUSE = /^\x1b\[M[\s\S]{3}$/;
const DCS_STRING = /^\x1bP[\s\S]*\x1b\\$/;
const CURSOR_POSITION = /^\x1b\[\d+;\d+R$/;
const MODE_REPORT = /^\x1b\[\?\d+(?:;\d+)*\$y$/;

/** True when the sequence should be dropped instead of reaching input handlers. */
export function isStrayTerminalInput(sequence: string): boolean {
	return (
		X10_MOUSE.test(sequence) ||
		DCS_STRING.test(sequence) ||
		CURSOR_POSITION.test(sequence) ||
		MODE_REPORT.test(sequence)
	);
}
