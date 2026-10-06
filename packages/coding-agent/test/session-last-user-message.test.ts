import type { AssistantMessage } from "@amazme/ai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

function assistant(text = "Assistant response"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("latest session question", () => {
	let directory: string;
	let manager: SessionManager;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "amazme-dashboard-session-"));
		manager = SessionManager.create("/repo", directory);
	});

	afterEach(() => rmSync(directory, { recursive: true, force: true }));

	async function listed() {
		const sessions = await SessionManager.list("/repo", directory);
		const session = sessions.find((info) => info.id === manager.getSessionId());
		expect(session).toBeDefined();
		return session!;
	}

	test("live and saved sessions use the latest user question, not the first message or later output", async () => {
		manager.appendMessage({ role: "user", content: "First question", timestamp: 1 });
		manager.appendMessage(assistant());
		manager.appendMessage({ role: "user", content: "Latest question", timestamp: 3 });
		manager.appendMessage(assistant("This is the answer, not a question"));
		manager.appendMessage({
			role: "bashExecution",
			command: "echo output",
			output: "Command output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			fullOutputPath: undefined,
			timestamp: 4,
		});
		manager.appendSessionInfo("Renamed title");

		expect(manager.getLastUserMessageText()).toBe("Latest question");
		expect(await listed()).toMatchObject({
			firstMessage: "First question",
			lastUserMessage: "Latest question",
			name: "Renamed title",
		});
		const reopened = SessionManager.open(manager.getSessionFile()!, directory);
		expect(reopened.getSessionName()).toBe("Renamed title");
		expect(reopened.getLastUserMessageText()).toBe("Latest question");
	});

	test("branch summaries and renames inherit the question on their own branch, not an abandoned branch", async () => {
		const root = manager.appendMessage({ role: "user", content: "Shared question", timestamp: 1 });
		manager.appendMessage(assistant());
		manager.appendMessage({ role: "user", content: "Abandoned question", timestamp: 3 });
		manager.appendMessage(assistant());
		manager.branchWithSummary(root, "Abandoned branch summary");
		manager.appendSessionInfo("Branch title");
		expect(manager.getLastUserMessageText()).toBe("Shared question");
		expect((await listed()).lastUserMessage).toBe("Shared question");

		manager.appendMessage({ role: "user", content: "New branch question", timestamp: 4 });
		manager.appendMessage(assistant());
		expect(manager.getLastUserMessageText()).toBe("New branch question");
		expect((await listed()).lastUserMessage).toBe("New branch question");
	});

	test("compaction does not lose the raw latest question even when model context retains no user message", async () => {
		manager.appendMessage({ role: "user", content: "Question before compaction", timestamp: 1 });
		manager.appendMessage(assistant());
		manager.appendCompaction("Compacted context", null, 1000);
		expect(manager.buildSessionContext().messages.some((message) => message.role === "user")).toBe(false);
		expect(manager.getLastUserMessageText()).toBe("Question before compaction");
		expect((await listed()).lastUserMessage).toBe("Question before compaction");
	});

	test("multi-part and image-only user prompts are represented without falling back to an older question", async () => {
		manager.appendMessage({ role: "user", content: "Old question", timestamp: 1 });
		manager.appendMessage(assistant());
		manager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "New question" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "with details" },
			],
			timestamp: 3,
		});
		expect(manager.getLastUserMessageText()).toBe("New question with details");
		expect((await listed()).lastUserMessage).toBe("New question with details");

		manager.appendMessage({ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 4 });
		expect(manager.getLastUserMessageText()).toBe("[Image]");
		expect((await listed()).lastUserMessage).toBe("[Image]");
	});

	test("an empty branch has no question instead of borrowing one from another root", async () => {
		expect(manager.getLastUserMessageText()).toBe("");
		manager.appendMessage({ role: "user", content: "Old root question", timestamp: 1 });
		manager.appendMessage(assistant());
		manager.resetLeaf();
		manager.appendCustomEntry("new-root");
		expect(manager.getLastUserMessageText()).toBe("");
		expect((await listed()).lastUserMessage).toBe("");
	});

	test("a whitespace-only latest prompt does not restore the first question", async () => {
		manager.appendMessage({ role: "user", content: "First question", timestamp: 1 });
		manager.appendMessage(assistant());
		manager.appendMessage({ role: "user", content: " \n\t ", timestamp: 3 });
		expect(manager.getLastUserMessageText()).toBe("");
		expect((await listed()).lastUserMessage).toBe("");
	});

	test("legacy linear session listing still finds the last user message without tree IDs", async () => {
		const path = join(directory, "legacy.jsonl");
		writeFileSync(
			path,
			[
				{ type: "session", version: 1, id: "legacy", cwd: "/repo", timestamp: new Date(0).toISOString() },
				{ type: "message", message: { role: "user", content: "First legacy question", timestamp: 1 } },
				{ type: "message", message: assistant() },
				{ type: "message", message: { role: "user", content: "Latest legacy question", timestamp: 3 } },
				{ type: "message", message: assistant() },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
		const sessions = await SessionManager.list("/repo", directory);
		expect(sessions.find((info) => info.id === "legacy")).toMatchObject({
			firstMessage: "First legacy question",
			lastUserMessage: "Latest legacy question",
		});
	});

	test("the live and saved reply track the latest answer, not the question", async () => {
		manager.appendMessage({ role: "user", content: "Question one", timestamp: 1 });
		manager.appendMessage(assistant("Reply one"));
		manager.appendMessage({ role: "user", content: "Question two", timestamp: 3 });
		expect(manager.getLastAssistantMessageText()).toBe("Reply one");
		expect((await listed()).lastAssistantMessage).toBe("Reply one");

		manager.appendMessage(assistant("Reply two"));
		expect(manager.getLastAssistantMessageText()).toBe("Reply two");
		expect(await listed()).toMatchObject({
			lastUserMessage: "Question two",
			lastAssistantMessage: "Reply two",
		});
	});

	test("a branch summary inherits the reply at the branch point, and an empty branch has none", async () => {
		manager.appendMessage({ role: "user", content: "Shared question", timestamp: 1 });
		const reply = manager.appendMessage(assistant("Shared reply"));
		manager.appendMessage({ role: "user", content: "Abandoned question", timestamp: 3 });
		manager.appendMessage(assistant("Abandoned reply"));
		manager.branchWithSummary(reply, "Branched summary");
		expect(manager.getLastAssistantMessageText()).toBe("Shared reply");
		expect((await listed()).lastAssistantMessage).toBe("Shared reply");

		manager.resetLeaf();
		manager.appendCustomEntry("new-root");
		expect(manager.getLastAssistantMessageText()).toBe("");
		expect((await listed()).lastAssistantMessage).toBe("");
	});
});
