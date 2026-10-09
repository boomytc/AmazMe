import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { InboxDoc, type SubmissionId, UserEntry } from "@amazme/durable";
import { describe, expect, test, vi } from "vitest";
import {
	automaticSessionName,
	firstSessionTitle,
	isSessionEmpty,
	watchSessionTitle,
} from "../src/host/session-lifecycle.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

const context = BACKGROUND_CONTEXT;

describe("session lifecycle", () => {
	test("uses a short Unicode title with normalized whitespace", () => {
		expect(automaticSessionName("  修复登录\n\t保持会话  ")).toBe("修复登录 保持会话");
		expect(automaticSessionName(" ")).toBe("");
		expect(Array.from(automaticSessionName("𠮷".repeat(80)))).toHaveLength(60);
		expect(automaticSessionName("𠮷".repeat(80))).toBe(`${"𠮷".repeat(59)}…`);
	});

	test("configuration is empty, but an entry in another conversation is not", async () => {
		const { harness, conversation, close } = await openFauxConversation();
		try {
			await conversation.configure({ thinkingLevel: "high" }, context);
			expect(await isSessionEmpty(harness, context)).toBe(true);
			const child = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
			await child.submit(
				{
					type: "write",
					entry: { kind: UserEntry.kind, model: [{ role: "user", content: "child input", timestamp: 1 }] },
				},
				context,
			);
			expect(await isSessionEmpty(harness, context)).toBe(false);
		} finally {
			await close();
		}
	});

	test("queued input is not an empty session before a transcript entry exists", async () => {
		const { harness, conversation, close } = await openFauxConversation();
		try {
			await harness.commit(async (tx) => {
				(await tx.doc(InboxDoc, conversation.id)).items.push({
					id: 1 as SubmissionId,
					mode: "followUp",
					content: "pending",
				});
			}, context);
			expect(await isSessionEmpty(harness, context)).toBe(false);
		} finally {
			await close();
		}
	});

	test("a live compaction prevents reuse even before it has written entries", async () => {
		const { harness, conversation, close } = await openFauxConversation();
		try {
			await conversation.compact(undefined, context);
			expect(await isSessionEmpty(harness, context)).toBe(false);
		} finally {
			await close();
		}
	});

	test("publishes once after commit and recovers the first title across reset and reopen", async () => {
		const { harness, conversation, close } = await openFauxConversation();
		const publish = vi.fn(async (_title: string) => {});
		const stop = watchSessionTitle(harness, conversation, "Image conversation", publish);
		try {
			expect(publish).not.toHaveBeenCalled();
			for (const content of ["首条\n消息", "second input"]) {
				await conversation.submit(
					{ type: "write", entry: { kind: UserEntry.kind, model: [{ role: "user", content, timestamp: 1 }] } },
					context,
				);
			}
			await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("首条 消息"));
			expect(publish).toHaveBeenCalledTimes(1);
			await conversation.reset(undefined, context);
			expect(await firstSessionTitle(conversation, "Image conversation")).toBe("首条 消息");
			expect(await isSessionEmpty(harness, context)).toBe(false);
			const recovered = vi.fn(async (_title: string) => {});
			const dispose = watchSessionTitle(harness, conversation, "Image conversation", recovered);
			try {
				await vi.waitFor(() => expect(recovered).toHaveBeenCalledWith("首条 消息"));
			} finally {
				dispose();
			}
		} finally {
			stop();
			await close();
		}
	});

	test("image-only first input gets a readable title", async () => {
		const { conversation, close } = await openFauxConversation();
		try {
			await conversation.submit(
				{
					type: "write",
					entry: {
						kind: UserEntry.kind,
						model: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "AA==" }], timestamp: 1 }],
					},
				},
				context,
			);
			expect(await firstSessionTitle(conversation, "图片会话")).toBe("图片会话");
		} finally {
			await close();
		}
	});
});
