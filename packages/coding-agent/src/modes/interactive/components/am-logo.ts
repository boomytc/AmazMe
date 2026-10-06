import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor, type Color } from "@amazme/tui";
import { theme } from "../theme/theme.ts";

const RESET = "\x1b[0m";

/** Coral, then yellow. The header mark and the text fallback both use these. */
export const AM_LOGO_CORAL: readonly [number, number, number] = [228, 138, 122];
export const AM_LOGO_YELLOW: readonly [number, number, number] = [234, 182, 93];

/**
 * AM, 10 cells wide and 2 lines tall. Each character is one pixel; a cell stacks two.
 *
 *   .██..█...█
 *   █..█.██.██
 *   ████.█.█.█
 *   █..█.█...█
 *
 * `c` is coral (A) and `y` is yellow (M). `.` is empty.
 */
export const AM_LOGO_ROWS = [".cc..y...y", "c..c.yy.yy", "cccc.y.y.y", "c..c.y...y"] as const;

const PALETTE: Record<string, readonly [number, number, number]> = {
	c: AM_LOGO_CORAL,
	y: AM_LOGO_YELLOW,
};

export const amLogoCellWidth = AM_LOGO_ROWS[0].length;

export function amLogoPixel(column: number, row: number): readonly [number, number, number] | undefined {
	const mark = AM_LOGO_ROWS[row]?.[column];
	if (!mark || mark === ".") return undefined;
	return PALETTE[mark];
}

function ansiColor(rgb: readonly [number, number, number]): Color {
	return rgbColor(rgb[0], rgb[1], rgb[2]);
}

function logoCell(
	top: readonly [number, number, number] | undefined,
	bottom: readonly [number, number, number] | undefined,
	mode: ReturnType<typeof theme.getColorMode>,
): string {
	const paint = (rgb: readonly [number, number, number]) => foregroundAnsi(ansiColor(rgb), mode);
	if (!top && !bottom) return " ";
	if (top && bottom && top === bottom) return `${paint(top)}█${RESET}`;
	if (top && bottom) return `${paint(top)}${backgroundAnsi(ansiColor(bottom), mode)}▀${RESET}`;
	if (top) return `${paint(top)}▀${RESET}`;
	return `${paint(bottom!)}▄${RESET}`;
}

/** Two half-block lines that spell AM. */
export function amLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const line = (topRow: number, bottomRow: number) => {
		let text = "";
		for (let column = 0; column < amLogoCellWidth; column++) {
			text += logoCell(amLogoPixel(column, topRow), amLogoPixel(column, bottomRow), mode);
		}
		return text;
	};
	return [line(0, 1), line(2, 3)];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsAmLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: coral A, yellow M. */
export function amWordmark(): string {
	const mode = theme.getColorMode();
	const paint = (rgb: readonly [number, number, number], text: string) =>
		`${foregroundAnsi(ansiColor(rgb), mode)}${text}${RESET}`;
	return `${paint(AM_LOGO_CORAL, "A")}${paint(AM_LOGO_YELLOW, "M")}`;
}
