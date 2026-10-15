import { createAssistantMessageEventStream, fauxAssistantMessage } from "@amazme/ai";
import { LiveDoc, MemoryStorage } from "@amazme/durable";
import { describe, expect, it } from "vitest";
import { allEntries, chatSetup, openChat, textOf } from "./chat-support.ts";
import { context } from "./session-support.ts";

describe("generation stream lifetime", () => {
	it.each(["abort", "close"] as const)("joins %s when provider next and return ignore cancellation", async (operation) => {
		const setup = chatSetup();
		setup.settings.stream = { idleTimeoutMs: 0 };
		const pending = createAssistantMessageEventStream();
		const entered = Promise.withResolvers<AbortSignal | undefined>();
		const original = setup.faux.provider.streamSimple.bind(setup.faux.provider);
		let calls = 0;
		setup.faux.provider.streamSimple = (model, transcript, options) => {
			calls++;
			if (calls > 1) return original(model, transcript, options);
			entered.resolve(options?.signal);
			return pending;
		};
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			const submission = await root.submit({ type: "input", content: "first" }, context);
			const signal = await entered.promise;
			if (operation === "close") {
				await harness.close(context);
				expect(signal?.aborted).toBe(true);
				return;
			}
			await root.abort(context);
			expect(signal?.aborted).toBe(true);
			expect(await submission.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
			expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
			setup.faux.setResponses([fauxAssistantMessage("after cancel")]);
			expect(await (await root.submit({ type: "input", content: "second" }, context)).wait(context)).toMatchObject({ status: "done" });
			pending.push({ type: "done", reason: "stop", message: fauxAssistantMessage("late") });
			await new Promise(resolve => setTimeout(resolve, 0));
			const texts = (await allEntries(root)).flatMap(entry => entry.model ?? []).map(textOf);
			expect(texts).toContain("after cancel");
			expect(texts).not.toContain("late");
			expect(setup.reports).toEqual([]);
		} finally {
			pending.end(fauxAssistantMessage("released"));
			await harness.close(context);
		}
	});
});
