/**
 * Verify the documentation example from extensions.md compiles and works.
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";

vi.mock("@amazme/coding-agent", () => ({
	convertToLlm: (messages: unknown) => messages,
	serializeConversation: () => "conversation",
}));

const { default: customCompactionExtension } = await import("../examples/extensions/custom-compaction.ts");

describe("Documentation example", () => {
	it("custom compaction example dispatches through modelRegistry.complete", async () => {
		let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
		customCompactionExtension({
			on(event, fn) {
				if (event === "session_before_compact") handler = fn as typeof handler;
			},
		} as ExtensionAPI);

		expect(handler).toBeDefined();

		const complete = vi.fn(async () => ({
			role: "assistant",
			content: [{ type: "text", text: "custom provider summary" }],
			provider: "example-custom",
			api: "example-custom-api",
			model: "summary-model",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		}));
		const model = {
			provider: "example-custom",
			api: "example-custom-api",
			id: "summary-model",
			name: "Summary Model",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};

		const result = await handler!(
			{
				preparation: {
					messagesToSummarize: [
						{ role: "user", content: [{ type: "text", text: "please remember this" }], timestamp: Date.now() },
					],
					turnPrefixMessages: [],
					tokensBefore: 42,
					firstKeptEntryId: "entry-1",
				},
				branchEntries: [],
				signal: new AbortController().signal,
			},
			{
				ui: { notify: vi.fn() },
				modelRegistry: {
					find: vi.fn(() => model),
					complete,
				},
			},
		);

		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({ messages: expect.any(Array) }),
			expect.objectContaining({ maxTokens: 8192 }),
		);
		expect(complete).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ apiKey: expect.anything() }),
		);
		expect(result).toMatchObject({
			compaction: {
				summary: "custom provider summary",
				firstKeptEntryId: "entry-1",
				tokensBefore: 42,
			},
		});
	});
});
