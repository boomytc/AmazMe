import type { AssistantMessage, Message, TextContent } from "../types.ts";
import { isContentInspectionRejection } from "./retry.ts";

export const IMAGE_RECOVERY_DIAGNOSTIC = "image_payload_recovery";
export const IMAGE_RECOVERY_RETRY_MESSAGE = "Image payload rejected; retrying without images. Original attachments are preserved.";
export const OMITTED_IMAGE_TEXT = "[Image omitted after the provider rejected its payload. This request cannot see the image.]";

/** Only payload rejections, never authentication, safety, quota, context, or transient failures. */
export function isImagePayloadRejection(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || message.content.some(block => block.type !== "text" || block.text.trim().length > 0)) return false;
	const error = message.errorMessage ?? "";
	if (!/\bimage\b|\bimages\b/i.test(error)) return false;
	if (isContentInspectionRejection(error)) return false;
	if (/\b(?:401|403|408|429|5\d\d)\b|auth|api[_ -]?key|permission|forbidden|denied|safety|unsafe|moderation|policy|content[_ -]?filter|blocked|prohibited|restricted|responsible.?ai|quota|billing|rate[_ -]?limit|context|tokens?|timeout|network/i.test(error)) return false;
	return /invalid|unsupported|corrupt|malformed|decod|format|mime|dimensions?|resolution|too large|too many|exceed|size|payload.{0,30}reject|at most 0 image|are not enabled/i.test(error);
}

export function hasRequestImages(messages: readonly Message[]): boolean {
	return messages.some(message =>
		(message.role === "user" || message.role === "toolResult") &&
		Array.isArray(message.content) && message.content.some(block => block.type === "image"),
	);
}

/** A request-only copy. Keep the transcript, message order, tool IDs, text, and image positions intact. */
export function omitRequestImages(messages: readonly Message[]): { messages: Message[]; omittedImages: number } {
	let omittedImages = 0;
	const projected = messages.map((message): Message => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		if (!Array.isArray(message.content) || !message.content.some(block => block.type === "image")) return message;
		const content = message.content.map(block => {
			if (block.type !== "image") return block;
			omittedImages++;
			return { type: "text", text: OMITTED_IMAGE_TEXT } satisfies TextContent;
		});
		return { ...message, content };
	});
	return { messages: projected, omittedImages };
}

/** Existing diagnostics carry the visible, persisted warning; no new message protocol or raw provider body. */
export function appendImageRecoveryDiagnostic(message: AssistantMessage, omittedImages: number): void {
	if (omittedImages === 0) return;
	message.diagnostics = [
		...(message.diagnostics ?? []).filter(diagnostic => diagnostic.type !== IMAGE_RECOVERY_DIAGNOSTIC),
		{ type: IMAGE_RECOVERY_DIAGNOSTIC, timestamp: message.timestamp, details: { omittedImages } },
	];
}
