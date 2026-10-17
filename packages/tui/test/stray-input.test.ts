import assert from "node:assert";
import { describe, it } from "node:test";
import { isStrayTerminalInput } from "../src/stray-input.ts";

describe("stray terminal input", () => {
	it("drops replies and reports that no surface consumes", () => {
		assert.strictEqual(isStrayTerminalInput("\x1b[Mabc"), true);
		assert.strictEqual(isStrayTerminalInput("\x1bP>|xterm(390)\x1b\\"), true);
		assert.strictEqual(isStrayTerminalInput("\x1b[12;40R"), true);
		assert.strictEqual(isStrayTerminalInput("\x1b[?2026;1$y"), true);
	});

	it("keeps keys, mouse events, OSC and APC replies", () => {
		assert.strictEqual(isStrayTerminalInput("a"), false);
		assert.strictEqual(isStrayTerminalInput("\x1b[A"), false);
		// DA replies terminate the color query, so they keep flowing.
		assert.strictEqual(isStrayTerminalInput("\x1b[?62;22c"), false);
		assert.strictEqual(isStrayTerminalInput("\x1b[<0;1;2M"), false);
		assert.strictEqual(isStrayTerminalInput("\x1b[?1u"), false);
		assert.strictEqual(isStrayTerminalInput("\x1b]11;rgb:0000/0000/0000\x07"), false);
		assert.strictEqual(isStrayTerminalInput("\x1b_Gi=1;OK\x1b\\"), false);
	});
});
