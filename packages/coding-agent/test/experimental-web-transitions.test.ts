import { describe, expect, test } from "vitest";
import { sessionTransitions } from "../src/host/web/page.ts";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the page's session transitions", () => {
	test("run one at a time, in the order they were asked for", async () => {
		const transition = sessionTransitions();
		const log: string[] = [];
		const first = transition(async () => {
			log.push("first:start");
			await tick(30);
			log.push("first:end");
		});
		// The later request starts while the first is still binding, which is the race the queue
		// exists for: without it, this transition would release the first one's bindings.
		const second = transition(async () => {
			log.push("second:start");
			await tick(5);
			log.push("second:end");
		});
		await Promise.all([first, second]);
		expect(log).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	test("hand each transition its own result", async () => {
		const transition = sessionTransitions();
		await expect(transition(async () => "first")).resolves.toBe("first");
		await expect(transition(async () => "second")).resolves.toBe("second");
	});

	test("a failed transition reaches its caller and does not block the next", async () => {
		const transition = sessionTransitions();
		const failure = new Error("Host did not attach session gone");
		const failed = transition(async () => {
			throw failure;
		});
		const next = transition(async () => "survived");
		await expect(failed).rejects.toThrow("Host did not attach session gone");
		await expect(next).resolves.toBe("survived");
	});
});
