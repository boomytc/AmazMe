import { createHash } from "node:crypto";
import type { Context } from "@amazme/chord";
import type { Message } from "@amazme/ai";
import { Type } from "@amazme/ai";
import { estimateMessageTokens } from "@amazme/ai/utils/estimate";
import { CompactionTask, defineExtension, defineTool, GenerationTask, hook, ToolResultEntry } from "@amazme/durable";
import type { ContextView, HookApi } from "@amazme/durable";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { ContextCleanupDoc } from "./state.ts";
import type { CleanupDecision } from "./state.ts";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const imageKey = (key: string, index: number): string => `${key}:image:${index}`;

function project(messages: readonly Message[], keys: ReadonlyMap<Message, string>, decisions: readonly CleanupDecision[]): Message[] {
	const saved = new Map(decisions.map(decision => [decision.key, decision]));
	return messages.map(message => {
		const key = keys.get(message);
		if (key === undefined) return message;
		if (message.role === "toolResult") {
			const decision = saved.get(key);
			const content = message.content.map((block, index) => {
				const image = block.type === "image" ? saved.get(imageKey(key, index)) : undefined;
				return image ? { type: "text" as const, text: `[历史工具图片 ${image.reference} 已卸载，不再发送；原图：context_detail(callId=${JSON.stringify(message.toolCallId)})]` } : block;
			});
			if (!decision) return content.some((block, index) => block !== message.content[index]) ? { ...message, content } : message;
			const text = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
			return { ...message, content: [...content.filter((block, index) => message.content[index]?.type !== "text"), { type: "text" as const,
				text: `${text.slice(0, decision.head)}\n\n[旧工具结果已精简；省略 ${text.length - decision.head - decision.tail} 字符。原文：context_detail(callId=${JSON.stringify(decision.reference)})]\n\n${text.slice(-decision.tail)}` }] };
		}
		if (message.role !== "user" || typeof message.content === "string") return message;
		const content = message.content.map((block, index) => {
			if (block.type !== "image") return block;
			const decision = saved.get(imageKey(key, index));
			return decision ? { type: "text" as const, text: `[历史图片 ${decision.reference} 已卸载，不再发送；原图保留在会话记录。]` } : block;
		});
		return content.some((block, index) => block !== message.content[index]) ? { ...message, content } : message;
	});
}

/** Stable projections reduce model input; raw transcript bytes and images are never deleted. */
export function createContextCleanup(settings: SettingsManager) {
	const projectContext = async (view: ContextView, api: HookApi, context: Context): Promise<ContextView> => {
		// Ordering keeps message objects from contributions. Entry identity distinguishes identical uploads, while
		// the fingerprint invalidates decisions if a context edit replaces that entry's model payload.
		const keys = new Map<Message, string>();
		for (const [index, messages] of view.contributions.entries()) {
			const entry = view.entries[index];
			if (!entry) continue;
			for (const [position, message] of messages.entries()) keys.set(message, `${entry.id}:${position}:${hash(message)}`);
		}
		const saved = (await api.snapshot(ContextCleanupDoc, api.conversationId, context))?.decisions ?? [];
		const known = new Set(saved.map(decision => decision.key));
		const additions: CleanupDecision[] = [];
		if (settings.getSettings().contextCleanup !== false) {
			const toolResults = view.messages.filter(message => message.role === "toolResult");
			for (const message of toolResults.slice(0, -2)) {
				if (message.role !== "toolResult") continue;
				const key = keys.get(message);
				if (key === undefined) continue;
				const size = message.content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
				if (!known.has(key) && size > 12000) additions.push({ key, kind: "tool", reference: message.toolCallId, head: 3000, tail: 3000 });
			}
			const images = view.messages.flatMap(message => {
				const key = keys.get(message);
				return key !== undefined && (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)
					? message.content.flatMap((block, index) => block.type === "image" ? [{ key: imageKey(key, index), reference: `${key.split(":")[0]}:${index + 1}` }] : []) : [];
			});
			for (const image of images.slice(0, -6)) if (!known.has(image.key)) additions.push({ ...image, kind: "image", head: 0, tail: 0 });
		}
		if (additions.length) await api.commit(async tx => {
			const doc = await tx.doc(ContextCleanupDoc, api.conversationId);
			for (const decision of additions) if (!doc.decisions.some(saved => saved.key === decision.key)) doc.decisions.push(decision);
		}, context);
		const decisions = [...saved, ...additions];
		const messages = project(view.messages, keys, decisions);
		const changed = messages.some((message, index) => message !== view.messages[index]);
		return { ...view, messages, contributions: view.contributions.map(messages => project(messages, keys, decisions)),
			...(changed ? { estimatedTokens: messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) } : {}) };
	};
	return defineExtension({ name: "context-cleanup", hooks: [hook(GenerationTask, { projectContext }), hook(CompactionTask, { projectContext })], tools: [defineTool({
		name: "context_detail", description: "Read a retained original tool result referenced by a context-cleanup marker.",
		parameters: Type.Object({ callId: Type.String() }), replay: "safe", annotations: { readOnlyHint: true },
		async execute({ callId }, api, context) {
			const result = await api.commit(async tx => {
				let cursor;
				do {
					const page = await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 100, cursor);
					for (const entry of page.items) if (entry.kind === ToolResultEntry.kind) for (const message of entry.model ?? []) if (message.role === "toolResult" && message.toolCallId === callId) return message.content;
					cursor = page.next;
				} while (cursor !== undefined);
				return undefined;
			}, context);
			if (!result) throw new Error("Original tool result is unavailable in this conversation");
			return { output: result };
		},
	})] });
}
