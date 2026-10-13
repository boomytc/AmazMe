import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import type { ToolHooks } from "@amazme/durable";
import { expect, test, vi } from "vitest";
import { createApprovalGate } from "../src/host/services/approvals-provider.ts";
import type { ApprovalsState } from "../src/host/services/approvals.ts";

function setup(now?: () => number) {
	const gate = createApprovalGate({
		mode: () => "all",
		...(now ? { now } : {}),
	});
	const state = replicatedState<ApprovalsState>({ revision: 0, pending: [] });
	gate.attach(state);
	const before = gate.extension.hooks![0]!.handlers.beforeTool as NonNullable<
		ToolHooks["beforeTool"]
	>;
	// These boundary checks do not resolve tool metadata; real Harness execution is covered by experimental-web-approvals.
	const api = { taskId: 1, conversationId: 1 } as unknown as Parameters<
		typeof before
	>[1];
	return {
		gate,
		state,
		run: (signal: AbortSignal) =>
			before(
				{ id: "read-1", name: "read", arguments: {} },
				api,
				withAbortSignal(signal, BACKGROUND_CONTEXT),
			),
	};
}

test("retains a decision made during publication and releases the cancellation listener", async () => {
	const fixture = setup();
	const controller = new AbortController();
	const removed = vi.spyOn(controller.signal, "removeEventListener");
	fixture.state.subscribe(() => {
		const id = fixture.state.value.pending[0]?.id;
		if (id) void fixture.gate.service().decide(id, true, BACKGROUND_CONTEXT);
	});
	await expect(fixture.run(controller.signal)).resolves.toBeUndefined();
	expect(fixture.state.value.pending).toEqual([]);
	expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
	await expect(
		fixture.gate.service().decide("approval-1", false, BACKGROUND_CONTEXT),
	).resolves.toBe(false);
});

test("cancellation during publication settles the waiter instead of leaving a pending request", async () => {
	const fixture = setup();
	const controller = new AbortController();
	const reason = new Error("session stopped");
	fixture.state.subscribe(() => {
		if (fixture.state.value.pending.length) controller.abort(reason);
	});
	await expect(fixture.run(controller.signal)).rejects.toBe(reason);
	expect(fixture.state.value.pending).toEqual([]);
	await expect(
		fixture.gate.service().decide("approval-1", true, BACKGROUND_CONTEXT),
	).resolves.toBe(false);
});

test("a cancellation before listener registration is observed and is not reported as reader denial", async () => {
	const controller = new AbortController();
	const reason = new Error("owner cancelled");
	const fixture = setup(() => {
		controller.abort(reason);
		return 1;
	});
	await expect(fixture.run(controller.signal)).rejects.toBe(reason);
	expect(fixture.state.value.pending).toEqual([]);
});
