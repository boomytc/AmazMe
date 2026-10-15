import { afterEach, describe, expect, it, vi } from "vitest";
import { complete, stream } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { testAbortSignal } from "./abort-utils.ts";

vi.mock("../src/compat.ts", () => ({ complete: vi.fn(), stream: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const model = getBuiltinModel("openai-codex", "gpt-6-luna");

function message(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "A".repeat(60) }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function mockAbortStream(terminal: AssistantMessage) {
	vi.mocked(stream).mockImplementation((_model, _context, options) => {
		const events = new AssistantMessageEventStream();
		events.push({ type: "text_delta", contentIndex: 0, delta: "A".repeat(60), partial: terminal });
		options?.signal?.addEventListener("abort", () => {
			if (terminal.stopReason === "aborted") events.push({ type: "error", reason: "aborted", error: terminal });
			else events.push({ type: "done", reason: "stop", message: terminal });
		});
		return events;
	});
}

describe("abort live-test assertions", () => {
	it("drains the abort event and verifies the follow-up conversation", async () => {
		mockAbortStream(message("aborted"));
		vi.mocked(complete).mockResolvedValue(message("stop"));
		await testAbortSignal(model);
		expect(complete).toHaveBeenCalledOnce();
		const [, context, options] = vi.mocked(complete).mock.calls[0];
		expect(context.messages[1]).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(options?.signal).toBeUndefined();
	});

	it("fails if a provider ignores abort instead of returning before the assertion", async () => {
		mockAbortStream(message("stop"));
		await expect(testAbortSignal(model)).rejects.toThrow();
		expect(complete).not.toHaveBeenCalled();
	});

	it("fails if the follow-up request fails after a successful abort", async () => {
		mockAbortStream(message("aborted"));
		vi.mocked(complete).mockResolvedValue(message("error"));
		await expect(testAbortSignal(model)).rejects.toThrow();
		expect(complete).toHaveBeenCalledOnce();
	});
});
