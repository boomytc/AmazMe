import { describe, expect, test } from "vitest";
import { INPUT_PRIORITY, promptOwnsKey, routeInteractiveInput } from "../src/modes/interactive/interactive-input.ts";

function surface(name: string, accepted: Set<string>, seen: string[]) {
	return {
		handleInput(data: string): boolean {
			seen.push(name);
			return accepted.has(data);
		},
	};
}

describe("interactive input routing", () => {
	test("offers a key to the child view, then the transcript, then the composer", () => {
		const seen: string[] = [];
		const handlers = {
			child: surface("child", new Set<string>(), seen),
			transcript: surface("transcript", new Set<string>(), seen),
			composer: surface("composer", new Set<string>(["x"]), seen),
		};

		expect(routeInteractiveInput("x", handlers)).toBe(true);
		expect(seen).toEqual(["child", "transcript", "composer"]);
	});

	test("stops at the first surface that consumes the key", () => {
		const seen: string[] = [];
		const handlers = {
			child: surface("child", new Set<string>(), seen),
			transcript: surface("transcript", new Set<string>(["x"]), seen),
			composer: surface("composer", new Set<string>(["x"]), seen),
		};

		expect(routeInteractiveInput("x", handlers)).toBe(true);
		expect(seen).toEqual(["child", "transcript"]);
	});

	test("reports an unconsumed key so the editor keeps it", () => {
		const seen: string[] = [];
		const handlers = {
			child: surface("child", new Set<string>(), seen),
			transcript: surface("transcript", new Set<string>(), seen),
			composer: surface("composer", new Set<string>(), seen),
		};

		expect(routeInteractiveInput("x", handlers)).toBe(false);
		expect(seen).toEqual([...INPUT_PRIORITY]);
	});

	test("the completion menu keeps navigation keys away from the scrollback", () => {
		for (const key of ["\t", "\x1b[Z", "\x1b[A", "\x1b[B", "\r", "\x1b"]) {
			expect(promptOwnsKey(key, true)).toBe(true);
		}
		expect(promptOwnsKey("\x1b[A", false)).toBe(false);
	});
});
