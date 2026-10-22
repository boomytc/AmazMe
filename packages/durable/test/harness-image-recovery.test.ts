import { type AssistantMessage, type Message, fauxAssistantMessage } from "@amazme/ai";
import { hasRequestImages, OMITTED_IMAGE_TEXT } from "@amazme/ai/utils/image-recovery";
import { copyJson } from "@amazme/chord";
import { describe, expect, it } from "vitest";
import { GenerationTask } from "../src/harness/generation.ts";
import type { TaskId } from "../src/types.ts";
import { LiveDoc } from "../src/harness/live.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { allEntries, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { context, ControlledStorage } from "./session-support.ts";

const IMAGE = { type: "image", data: "original-image", mimeType: "image/png" } as const;
const REJECTED = fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 Invalid image: dimensions exceed the supported limit" });

describe("durable image payload recovery", () => {
	it.each([false, true])("recovers once, preserving history and a visible diagnostic (deferred=%s)", async deferred => {
		const setup = chatSetup(deferred ? { deferred: { pendingFetches: 0, pollAfterMs: 1 } } : {});
		const seen: Message[][] = [];
		setup.faux.setResponses([
			request => { seen.push(structuredClone(request.messages)); return REJECTED; },
			request => { seen.push(structuredClone(request.messages)); return fauxAssistantMessage("text-only answer"); },
			request => { seen.push(structuredClone(request.messages)); return fauxAssistantMessage("next answer"); },
		]);
		setup.settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
		if (deferred) setup.settings.stream = { deferred: true };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			harness.resume();
			const submission = await root.submit({ type: "input", content: [{ type: "text", text: "question" }, IMAGE] }, context);
			expect(await submission.wait(context)).toMatchObject({ status: "done" });
			expect(seen).toHaveLength(2);
			expect(hasRequestImages(seen[0]!)).toBe(true);
			expect(hasRequestImages(seen[1]!)).toBe(false);
			expect(JSON.stringify(seen[1])).toContain(OMITTED_IMAGE_TEXT);
			const entries = await allEntries(root);
			expect(entries[0]?.model?.[0]).toMatchObject({ content: [{ text: "question" }, IMAGE] });
			const answer = entries.at(-1)?.model?.[0] as AssistantMessage;
			expect(answer.diagnostics).toContainEqual({ type: "image_payload_recovery", timestamp: answer.timestamp, details: { omittedImages: 1 } });
			await (await root.submit({ type: "input", content: "next question" }, context)).wait(context);
			expect(hasRequestImages(seen[2]!)).toBe(true);
			expect(setup.models.getModel("faux", "faux-1")?.input).toContain("image");
		} finally { await harness.close(context); }
	});

	it.each([
		{ images: true, enabled: false, error: REJECTED, expected: 1 },
		{ images: false, enabled: true, error: REJECTED, expected: 1 },
		{ images: true, enabled: true, error: fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 Invalid image: content_policy_violation" }), expected: 1 },
		{ images: true, enabled: true, error: REJECTED, expected: 2 },
	])("obeys retry policy and never repeats the payload fallback: %j", async ({ images, enabled, error, expected }) => {
		const setup = chatSetup();
		setup.settings.retry = { enabled, maxRetries: 3, baseDelayMs: 1 };
		setup.faux.setResponses([error, error, fauxAssistantMessage("never")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			harness.resume();
			expect(await (await root.submit({ type: "input", content: images ? [IMAGE] : "plain" }, context)).wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
			expect(setup.faux.state.callCount).toBe(expected);
		} finally { await harness.close(context); }
	});

	it.each(["inappropriate content", "data_inspection_failed", "DataInspectionFailed"])("preserves a content rejection without retrying or omitting attachments: %s", async reason => {
		const setup = chatSetup();
		const errorMessage = `400 Invalid image: ${reason}`;
		setup.settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
		setup.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage }),
			fauxAssistantMessage("must not retry"),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			const submission = await root.submit({ type: "input", content: [IMAGE] }, context);
			expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
			expect(setup.faux.state.callCount).toBe(1);
			const entries = await allEntries(root);
			expect(entries[0]?.model?.[0]).toMatchObject({ content: [IMAGE] });
			const answer = entries.at(-1)?.model?.[0] as AssistantMessage;
			expect(answer).toMatchObject({ stopReason: "error", errorMessage });
			expect(answer.diagnostics?.some(diagnostic => diagnostic.type === "image_payload_recovery")).not.toBe(true);
		} finally { await harness.close(context); }
	});

	it("resumes the committed recovery after restart without sending the rejected images again", async () => {
		const storage = new ControlledStorage();
		const setup = chatSetup();
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 60_000 };
		setup.faux.setResponses([REJECTED, request => {
			expect(hasRequestImages(request.messages)).toBe(false);
			return fauxAssistantMessage("recovered after restart");
		}]);
		const first = await openChat(storage, setup);
		first.harness.resume();
		const submission = await first.root.submit({ type: "input", content: [IMAGE] }, context);
		await waitFor(async () => (await first.harness.snapshot(LiveDoc, first.root.id, context))?.generation?.retry !== undefined);
		await first.harness.close(context);
		setup.now = () => Date.now() + 60_100;
		const again = await openChat(storage.reopen(), setup);
		try {
			again.harness.resume();
			expect(await (await again.harness.submission(submission.id, context))!.wait(context)).toMatchObject({ status: "done" });
			expect(setup.faux.state.callCount).toBe(2);
			expect((await allEntries(again.root)).at(-1)?.model?.[0]).toMatchObject({ diagnostics: [{ type: "image_payload_recovery" }] });
		} finally { await again.harness.close(context); }
	});

	it("honors cancellation during the recovery backoff", async () => {
		const setup = chatSetup();
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 60_000 };
		setup.faux.setResponses([REJECTED, fauxAssistantMessage("never")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			harness.resume();
			const submission = await root.submit({ type: "input", content: [IMAGE] }, context);
			await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.generation?.retry !== undefined);
			const live = await harness.snapshot(LiveDoc, root.id, context);
			await harness.abortTask(live!.run!.taskId, context);
			expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
			expect(setup.faux.state.callCount).toBe(1);
		} finally { await harness.close(context); }
	});

	it("migrates v1/v2 checkpoints but rejects a v1 yield phase", async () => {
		const migrate = GenerationTask.definition.migrate!;
		const task = { id: 1 as TaskId };
		for (const version of [1, 2]) expect(await migrate({}, { phase: "prepare", attempt: 1 }, version, task)).toMatchObject({ checkpoint: { phase: "prepare", attempt: 1 } });
		expect(() => migrate({}, copyJson({ phase: "yield", message: fauxAssistantMessage("saved") }, { omitUndefinedProperties: true }), 1, task)).toThrow("Invalid v1 generation checkpoint");
		expect(await migrate({}, copyJson({ phase: "yield", message: fauxAssistantMessage("saved") }, { omitUndefinedProperties: true }), 2, task)).toMatchObject({ checkpoint: { phase: "yield" } });
	});
});
