import type { TaskGraphNode } from "@amazme/durable";
import { describe, expect, it } from "vitest";
import { describeTask } from "../src/durable/tui.ts";

const node: TaskGraphNode = {
	id: 12 as TaskGraphNode["id"],
	kind: "amazme.generation",
	conversationId: 1 as TaskGraphNode["conversationId"],
	background: false,
	abortRequested: false,
	state: { status: "pending", phase: "generate" },
	blocked: "restart_limit",
	restarts: 3,
	conversations: [],
};

describe("native task description", () => {
	it("shows the restart count and the configured limit from the graph", () => {
		expect(describeTask(node, 3)).toContain("blocked (restart_limit, 3/3 restarts)");
		expect(describeTask(node, 7)).toContain("blocked (restart_limit, 3/7 restarts)");
	});

	it("shows restarts on a task that is not parked", () => {
		expect(describeTask({ ...node, blocked: undefined, restarts: 2 }, 5)).toContain("2/5 restarts");
		expect(describeTask({ ...node, blocked: undefined, restarts: undefined }, 5)).not.toContain("restarts");
	});

	it("shows only the count when the bound is off, whether it arrives as Infinity or as JSON's null", () => {
		const running = { ...node, blocked: undefined, restarts: 2 };
		for (const limit of [Number.POSITIVE_INFINITY, null]) {
			const text = describeTask(running, limit);
			expect(text).toContain(", 2 restarts");
			expect(text).not.toMatch(/null|Infinity/);
		}
	});
});
