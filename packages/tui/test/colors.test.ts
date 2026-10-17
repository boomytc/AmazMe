import assert from "node:assert";
import { describe, it } from "node:test";
import {
	backgroundAnsi,
	colorToHex,
	colorToOkhsl,
	colorToRgb,
	indexedColor,
	okhslColor,
	oklchColor,
	foregroundAnsi,
	getTerminalColorMode,
	parseColor,
	rgbColor,
	rgbToAnsi16,
	styleText,
} from "../src/index.ts";

describe("colors", () => {
	it("parses hex and OKLCH colors and rejects everything else", () => {
		assert.deepStrictEqual(parseColor("#abc"), { kind: "rgb", r: 170, g: 187, b: 204 });
		assert.deepStrictEqual(parseColor("oklch(62% 0.1 200)"), { kind: "oklch", l: 0.62, c: 0.1, h: 200 });
		assert.throws(() => parseColor(""), /Invalid color value/);
		assert.throws(() => parseColor("red"), /Invalid color value/);
	});

	it("gamut-maps OKLCH to sRGB, including the lightness limits", () => {
		assert.deepStrictEqual(colorToRgb(oklchColor(0.627955, 0.257683, 29.2339)), { r: 255, g: 0, b: 0 });
		assert.deepStrictEqual(colorToRgb(oklchColor(1, 0.3, 150)), { r: 255, g: 255, b: 255 });
		assert.deepStrictEqual(colorToRgb(oklchColor(0, 0.3, 150)), { r: 0, g: 0, b: 0 });
	});

	it("parses OKHSL colors and round-trips them", () => {
		// Full saturation at the red cusp is pure sRGB red.
		assert.deepStrictEqual(parseColor("okhsl(29.23 100% 56.8%)"), rgbColor(255, 0, 0));
		assert.deepStrictEqual(parseColor("OKHSL(250deg 60% 55%)"), okhslColor(250, 0.6, 0.55));
		assert.throws(() => parseColor("okhsl(250 160% 55%)"), /s must be between 0 and 1/);
		for (const hex of ["#4f8eb3", "#20242a", "#f8f9fa"]) {
			const { h, s, l } = colorToOkhsl(parseColor(hex));
			assert.strictEqual(colorToHex(okhslColor(h, s, l)), hex);
		}
	});

	it("styles text and closes sequences in reverse order", () => {
		assert.strictEqual(
			styleText("Ready", { fg: rgbColor(18, 52, 86), bg: indexedColor(9), bold: true, italic: true }, "truecolor"),
			"\x1b[38;2;18;52;86m\x1b[48;5;9m\x1b[1m\x1b[3mReady\x1b[23m\x1b[22m\x1b[49m\x1b[39m",
		);
		assert.match(styleText("Ready", { fg: rgbColor(18, 52, 86) }, "256color"), /^\x1b\[38;5;\d+mReady\x1b\[39m$/);
	});
});

describe("sixteen-color fallback", () => {
	it("maps RGB to the nearest ANSI color", () => {
		assert.strictEqual(rgbToAnsi16(rgbColor(255, 0, 0)), 9);
		assert.strictEqual(rgbToAnsi16(rgbColor(0, 0, 0)), 0);
		assert.strictEqual(rgbToAnsi16(rgbColor(255, 255, 255)), 15);
		assert.strictEqual(rgbToAnsi16(rgbColor(128, 0, 0)), 1);
		assert.strictEqual(rgbToAnsi16(rgbColor(192, 192, 192)), 7);
	});

	it("emits indexed escapes for foreground and background", () => {
		assert.strictEqual(foregroundAnsi(rgbColor(255, 0, 0), "16color"), "\x1b[38;5;9m");
		assert.strictEqual(backgroundAnsi(rgbColor(255, 0, 0), "16color"), "\x1b[48;5;9m");
		assert.strictEqual(foregroundAnsi(rgbColor(255, 0, 0), "256color"), "\x1b[38;5;196m");
		assert.strictEqual(foregroundAnsi(indexedColor(42), "16color"), "\x1b[38;5;42m");
	});

	it("keeps truecolor output unchanged", () => {
		assert.strictEqual(foregroundAnsi(rgbColor(1, 2, 3), "truecolor"), "\x1b[38;2;1;2;3m");
	});
});

describe("terminal color mode", () => {
	it("honours the explicit color-mode override", () => {
		const previous = process.env.AMAZME_COLOR_MODE;
		process.env.AMAZME_COLOR_MODE = "16";
		try {
			assert.strictEqual(getTerminalColorMode({ images: null, trueColor: true, hyperlinks: false }), "16color");
			process.env.AMAZME_COLOR_MODE = "truecolor";
			assert.strictEqual(getTerminalColorMode({ images: null, trueColor: false, hyperlinks: false }), "truecolor");
		} finally {
			if (previous === undefined) delete process.env.AMAZME_COLOR_MODE;
			else process.env.AMAZME_COLOR_MODE = previous;
		}
	});

	it("falls back to sixteen colors when the capability says so", () => {
		const previousTerm = process.env.TERM;
		const previousMode = process.env.AMAZME_COLOR_MODE;
		delete process.env.AMAZME_COLOR_MODE;
		process.env.TERM = "xterm-256color";
		try {
			assert.strictEqual(getTerminalColorMode({ images: null, trueColor: false, ansi256: false, hyperlinks: false }), "16color");
			assert.strictEqual(getTerminalColorMode({ images: null, trueColor: false, hyperlinks: false }), "256color");
		} finally {
			if (previousTerm === undefined) delete process.env.TERM;
			else process.env.TERM = previousTerm;
			if (previousMode === undefined) delete process.env.AMAZME_COLOR_MODE;
			else process.env.AMAZME_COLOR_MODE = previousMode;
		}
	});
});
