import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "../src/types.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { appendImageRecoveryDiagnostic, hasRequestImages, isImagePayloadRejection, OMITTED_IMAGE_TEXT, omitRequestImages } from "../src/utils/image-recovery.ts";

describe("request-only image recovery", () => {
	it.each([
		"400 Invalid image: image dimensions exceed the supported limit",
		"422 Failed to decode image: unsupported format",
		"413 Image is too large",
	])("recognizes payload rejection: %s", errorMessage => {
		expect(isImagePayloadRejection(fauxAssistantMessage([], { stopReason: "error", errorMessage }))).toBe(true);
	});
	it.each([
		"403 Invalid image: permission denied",
		"400 Invalid image: content_policy_violation",
		"400 Invalid image: safety filter",
		"429 Image rate limit exceeded",
		"503 Failed to decode image",
		"Image quota exceeded",
		"Image context token limit exceeded",
		"Network error decoding image",
		"Invalid request",
	])("does not bypass other failures: %s", errorMessage => {
		expect(isImagePayloadRejection(fauxAssistantMessage([], { stopReason: "error", errorMessage }))).toBe(false);
	});
	it("does not replace a partially answered or aborted request", () => {
		expect(isImagePayloadRejection(fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "Invalid image" }))).toBe(false);
		expect(isImagePayloadRejection(fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "Invalid image" }))).toBe(false);
	});
	it("preserves frozen history and text, replacing user and tool images in their positions", () => {
		const original: Message[] = [
			{ role: "user", timestamp: 1, content: [{ type: "text", text: "before" }, { type: "image", data: "user", mimeType: "image/png" }, { type: "text", text: "after" }] },
			{ role: "toolResult", timestamp: 2, toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "image", data: "tool", mimeType: "image/jpeg" }] },
			{ role: "user", timestamp: 3, content: "plain" },
		];
		const snapshot = JSON.stringify(original);
		for (const message of original) {
			if (Array.isArray(message.content)) {
				for (const block of message.content) Object.freeze(block);
				Object.freeze(message.content);
			}
			Object.freeze(message);
		}
		Object.freeze(original);
		const result = omitRequestImages(original);
		expect(result.omittedImages).toBe(2);
		expect(hasRequestImages(original)).toBe(true);
		expect(hasRequestImages(result.messages)).toBe(false);
		expect(result.messages[0]).toMatchObject({ content: [{ text: "before" }, { text: OMITTED_IMAGE_TEXT }, { text: "after" }] });
		expect(result.messages[1]).toMatchObject({ toolCallId: "call-1", toolName: "read", content: [{ text: OMITTED_IMAGE_TEXT }] });
		expect(result.messages[2]).toBe(original[2]);
		expect(JSON.stringify(original)).toBe(snapshot);
	});
	it("records only the omission count, without leaking image data or provider bodies", () => {
		const message: AssistantMessage = fauxAssistantMessage("ok");
		appendImageRecoveryDiagnostic(message, 2);
		appendImageRecoveryDiagnostic(message, 2);
		expect(message.diagnostics).toEqual([{ type: "image_payload_recovery", timestamp: message.timestamp, details: { omittedImages: 2 } }]);
	});
});
