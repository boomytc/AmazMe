import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { describe, expect, it } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { fauxAssistantMessage, getModel } from "../src/compat.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

describe("Anthropic tool-result images", () => {
	// #10794: an error from a script that showed images must not produce an invalid Anthropic request.
	it.each([true, false])("only omits images from error results (isError: %s)", async isError => {
		const model = { ...getModel("anthropic", "claude-sonnet-4-5"), baseUrl: "http://127.0.0.1:9" };
		const context = normalizeContext({ messages: [
			{ role: "user", content: "Run a script", timestamp: 1 },
			{ ...fauxAssistantMessage([{ type: "toolCall", id: "script-1", name: "codemode", arguments: {} }]),
				api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse" },
			{ role: "toolResult", toolCallId: "script-1", toolName: "codemode", timestamp: 2, isError,
				content: [{ type: "text", text: "script result" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
		] });
		const original = JSON.stringify(context);
		let payload: MessageCreateParamsStreaming | undefined;
		await stream(model, context, { apiKey: "fixture-key", onPayload: value => {
			payload = value as MessageCreateParamsStreaming;
			throw new Error("payload captured before sending");
		} }).result();
		expect(payload).toBeDefined();
		const result = payload!.messages.flatMap(message => typeof message.content === "string" ? [] : message.content)
			.find(block => block.type === "tool_result");
		expect(result).toMatchObject({ is_error: isError, content: isError
			? "script result\n[image omitted: error tool results cannot contain images]"
			: [{ type: "text", text: "script result" },
				{ type: "image", source: { type: "base64", data: "aW1hZ2U=", media_type: "image/png" } }] });
		expect(JSON.stringify(context)).toBe(original);
	});
});
