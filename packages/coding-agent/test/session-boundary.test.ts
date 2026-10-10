import { existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AssistantMessage, UserMessage } from "@amazme/ai";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { Conversation } from "@amazme/durable";
import { UserEntry } from "@amazme/durable";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCustomMessage } from "../src/core/messages.ts";
import { sessionEntriesToDurableDrafts } from "../src/core/session-interop.ts";
import { SessionManager, type SessionEntry } from "../src/core/session-manager.ts";
import { startSessionHandoff } from "../src/host/session-handoff.ts";
import {
	deleteLocalSessionFiles,
	listLocalSessions,
	readLocalSession,
	writeSessionMirror,
} from "../src/host/session-store.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

vi.mock("node:fs/promises", { spy: true });

const CREATED_AT = 1_700_000_000_000;

function user(content: string): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "test",
		model: "test",
		api: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function messagesOf(entries: readonly SessionEntry[]): (UserMessage | AssistantMessage)[] {
	return entries.map((entry) => {
		if (entry.type !== "message") throw new Error(entry.type);
		if (entry.message.role !== "user" && entry.message.role !== "assistant") throw new Error(entry.message.role);
		return entry.message;
	});
}

describe("hosted session handoff", () => {
	let root: string;
	let cwd: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "amazme-session-boundary-"));
		cwd = join(root, "project");
		await mkdir(cwd);
		await mkdir(join(root, "profile"));
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", join(root, "profile"));
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	function writeBranchedSession(id: string): SessionManager {
		const session = SessionManager.create(cwd, undefined, { id });
		const rootId = session.appendMessage(user("root"));
		session.appendMessage(assistant("off-branch"));
		session.appendModelChange("provider", "model");
		session.appendThinkingLevelChange("high");
		session.appendLabelChange(rootId, "start");
		session.appendSessionInfo("kept-name");
		session.appendMessage(
			createCustomMessage("note", "from an extension", true, undefined, "2026-10-07T00:00:00.000Z"),
		);
		session.branch(rootId);
		session.branchWithSummary(rootId, "abandoned the main line");
		session.appendMessage(user("on-branch"));
		return session;
	}

	async function handoff(
		conversation: Conversation,
		sessionId: string,
		reports: string[],
	): Promise<void> {
		const started = await startSessionHandoff({
			conversation,
			sessionId,
			cwd,
			createdAt: CREATED_AT,
			report: (line) => {
				reports.push(line);
			},
		});
		await started.dispose();
	}

	test("seeds an empty durable transcript from the same-id terminal file and counts carried and skipped entries", async () => {
		writeBranchedSession("branch1");
		const opened = await openFauxConversation();
		try {
			const reports: string[] = [];
			await handoff(opened.conversation, "branch1", reports);
			expect(reports).toEqual([
				"amazme: session branch1 started from the terminal transcript: 3 carried, skipped model_change×1, thinking_level_change×1, label×1, session_info×1, message:custom×1, branch_summary×1",
			]);
			const page = await opened.conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
			expect(page.items.map((entry) => entry.kind)).toEqual(["amazme.user", "amazme.assistant", "amazme.user"]);
			expect(page.items.flatMap((entry) => entry.model ?? [])).toEqual([
				user("root"),
				assistant("off-branch"),
				user("on-branch"),
			]);
		} finally {
			await opened.close();
		}
	});

	test("does not seed when the durable transcript already has an entry", async () => {
		const session = SessionManager.create(cwd, undefined, { id: "hosted1" });
		session.appendMessage(user("terminal-only"));
		const opened = await openFauxConversation();
		try {
			await opened.conversation.submit(
				{ type: "write", entry: { kind: UserEntry.kind, model: [user("hosted")] } },
				BACKGROUND_CONTEXT,
			);
			const reports: string[] = [];
			await handoff(opened.conversation, "hosted1", reports);
			expect(reports.some((line) => line.includes("started from the terminal transcript"))).toBe(false);
			const page = await opened.conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
			expect(page.items.flatMap((entry) => entry.model ?? [])).toEqual([user("hosted")]);
		} finally {
			await opened.close();
		}
	});

	test("a failed mirror and a leftover tmp file leave the terminal session readable", async () => {
		const session = SessionManager.create(cwd, undefined, { id: "sess1" });
		session.appendMessage(user("original"));
		const path = session.getSessionFile();
		if (path === undefined) throw new Error("expected a session file");
		const original = await readFile(path, "utf8");
		const leftover = `${path}.tmp-${process.pid}`;
		await writeFile(leftover, "{\"not\":\"a session\"}\n");
		expect((await listLocalSessions(cwd)).map((item) => item.path)).toEqual([path]);

		vi.mocked(fsPromises.rename).mockRejectedValueOnce(new Error("rename failed"));
		await expect(
			writeSessionMirror({
				path,
				sessionId: "sess1",
				cwd,
				createdAt: CREATED_AT,
				entries: [{ id: 1, kind: "amazme.user", model: [user("replacement")] }],
			}),
		).rejects.toThrow("rename failed");

		expect(await readFile(path, "utf8")).toBe(original);
		expect(existsSync(leftover)).toBe(true);
		expect(await readFile(leftover, "utf8")).toContain("replacement");
		expect((await listLocalSessions(cwd)).map((item) => item.path)).toEqual([path]);
		expect((await readLocalSession(cwd, "sess1"))?.entries[0]).toMatchObject({ message: user("original") });
		expect(SessionManager.open(path).getEntries()[0]).toMatchObject({ message: user("original") });
	});

	test("deletes only files for the same cwd and the same id", async () => {
		const other = join(root, "other");
		await mkdir(other);
		const drop = SessionManager.create(cwd, undefined, { id: "drop1" });
		drop.appendMessage(user("drop"));
		const dropPath = drop.getSessionFile();
		if (dropPath === undefined) throw new Error("expected a session file");
		const dropCopy = join(dirname(dropPath), "1999-01-01T00-00-00-000Z_drop1.jsonl");
		await writeFile(dropCopy, await readFile(dropPath, "utf8"));
		const keep = SessionManager.create(cwd, undefined, { id: "keep1" });
		keep.appendMessage(user("keep"));
		const keepPath = keep.getSessionFile();
		if (keepPath === undefined) throw new Error("expected a session file");
		const foreign = SessionManager.create(other, undefined, { id: "drop1" });
		foreign.appendMessage(user("other-cwd"));
		const foreignPath = foreign.getSessionFile();
		if (foreignPath === undefined) throw new Error("expected a session file");
		const notes = join(dirname(dropPath), "notes.txt");
		const tmp = `${keepPath}.tmp-${process.pid}`;
		await writeFile(notes, "notes");
		await writeFile(tmp, "tmp");

		await deleteLocalSessionFiles(cwd, "drop1");

		expect(existsSync(dropPath)).toBe(false);
		expect(existsSync(dropCopy)).toBe(false);
		expect(existsSync(keepPath)).toBe(true);
		expect(existsSync(foreignPath)).toBe(true);
		expect(existsSync(notes)).toBe(true);
		expect(existsSync(tmp)).toBe(true);
		expect(SessionManager.open(keepPath).getEntries()[0]).toMatchObject({ message: user("keep") });
		expect(SessionManager.open(foreignPath).getEntries()[0]).toMatchObject({ message: user("other-cwd") });
	});
});

describe("current behavior, not a contract", () => {
	let root: string;
	let cwd: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "amazme-session-boundary-"));
		cwd = join(root, "project");
		await mkdir(cwd);
		await mkdir(join(root, "profile"));
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", join(root, "profile"));
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	test("seed plus one mirror flattens a branched terminal file and drops bookkeeping entries", async () => {
		const session = SessionManager.create(cwd, undefined, { id: "branch1" });
		const rootId = session.appendMessage(user("root"));
		session.appendMessage(assistant("off-branch"));
		session.appendModelChange("provider", "model");
		session.appendThinkingLevelChange("high");
		session.appendLabelChange(rootId, "start");
		session.appendSessionInfo("kept-name");
		session.appendMessage(
			createCustomMessage("note", "from an extension", true, undefined, "2026-10-07T00:00:00.000Z"),
		);
		session.branch(rootId);
		session.branchWithSummary(rootId, "abandoned the main line");
		session.appendMessage(user("on-branch"));
		const path = session.getSessionFile();
		if (path === undefined) throw new Error("expected a session file");
		const originalText = await readFile(path, "utf8");
		const originalIds = session.getEntries().map((entry) => entry.id);
		expect(originalText).toContain("\"type\":\"model_change\"");
		expect(originalText).toContain("\"type\":\"thinking_level_change\"");
		expect(originalText).toContain("\"type\":\"label\"");
		expect(originalText).toContain("\"type\":\"session_info\"");
		expect(originalText).toContain("\"type\":\"branch_summary\"");
		expect(originalText).toContain("from an extension");
		expect(session.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant")).toBe(
			false,
		);
		const opened = await openFauxConversation();
		try {
			const started = await startSessionHandoff({
				conversation: opened.conversation,
				sessionId: "branch1",
				cwd,
				createdAt: CREATED_AT,
				report: () => {},
			});
			await started.dispose();
			const mirrored = SessionManager.open(path);
			const entries = mirrored.getEntries();
			expect(entries).toHaveLength(3);
			expect(entries.map((entry) => entry.parentId)).toEqual([null, entries[0]!.id, entries[1]!.id]);
			expect(messagesOf(entries)).toEqual([user("root"), assistant("off-branch"), user("on-branch")]);
			expect(entries.every((entry) => entry.timestamp === new Date(CREATED_AT).toISOString())).toBe(true);
			expect(mirrored.getHeader()).toMatchObject({
				type: "session",
				version: 3,
				id: "branch1",
				cwd,
				timestamp: new Date(CREATED_AT).toISOString(),
			});
			expect(mirrored.getSessionName()).toBeUndefined();
			const text = await readFile(path, "utf8");
			expect(text).not.toBe(originalText);
			for (const id of originalIds) expect(text).not.toContain(`"id":"${id}"`);
			for (const gone of [
				"\"type\":\"model_change\"",
				"\"type\":\"thinking_level_change\"",
				"\"type\":\"label\"",
				"\"type\":\"session_info\"",
				"\"type\":\"branch_summary\"",
				"\"role\":\"custom\"",
				"kept-name",
				"from an extension",
				"abandoned the main line",
			]) {
				expect(text).not.toContain(gone);
			}
		} finally {
			await opened.close();
		}
	});

	test("a non-empty durable transcript is not seeded, and the mirror still replaces the terminal file", async () => {
		const session = SessionManager.create(cwd, undefined, { id: "hosted1" });
		session.appendMessage(user("terminal-only"));
		const path = session.getSessionFile();
		if (path === undefined) throw new Error("expected a session file");
		const opened = await openFauxConversation();
		try {
			await opened.conversation.submit(
				{ type: "write", entry: { kind: UserEntry.kind, model: [user("hosted")] } },
				BACKGROUND_CONTEXT,
			);
			const started = await startSessionHandoff({
				conversation: opened.conversation,
				sessionId: "hosted1",
				cwd,
				createdAt: CREATED_AT,
				report: () => {},
			});
			await started.dispose();
			expect(messagesOf(SessionManager.open(path).getEntries())).toEqual([user("hosted")]);
			expect(await readFile(path, "utf8")).not.toContain("terminal-only");
		} finally {
			await opened.close();
		}
	});

	test("a linear compaction is not kept equivalent across JSONL, durable, and JSONL", async () => {
		const session = SessionManager.create(cwd, undefined, { id: "compact1" });
		const first = session.appendMessage(user("before"));
		session.appendMessage(assistant("reply"));
		session.appendCompaction("the plan", first, 10);
		session.appendMessage(user("after"));
		const path = session.getSessionFile();
		if (path === undefined) throw new Error("expected a session file");
		expect(session.buildSessionContext().messages.some((message) => message.role === "user" && message.content === "before")).toBe(
			true,
		);
		const opened = await openFauxConversation();
		try {
			const started = await startSessionHandoff({
				conversation: opened.conversation,
				sessionId: "compact1",
				cwd,
				createdAt: CREATED_AT,
				report: () => {},
			});
			await started.dispose();
			const stored = await opened.conversation.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
			const mirrored = SessionManager.open(path);
			const local = await readLocalSession(cwd, "compact1");
			if (local === undefined) throw new Error("expected the mirrored session");
			const again = sessionEntriesToDurableDrafts(local.entries);
			expect(stored.items.map((entry) => entry.kind)).toEqual([
				"amazme.user",
				"amazme.assistant",
				"amazme.reset",
				"amazme.user",
			]);
			const carried = mirrored
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
				);
			expect(messagesOf(carried)).toEqual([user("after")]);
			const summary = mirrored
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "compactionSummary");
			if (summary === undefined || summary.type !== "message" || summary.message.role !== "compactionSummary") {
				throw new Error("expected a compaction summary");
			}
			expect(summary.message).toMatchObject({ summary: "the plan", tokensBefore: 0 });
			expect(again.drafts).toMatchObject([{ kind: "amazme.user", model: [user("after")] }]);
			expect(again.report).toEqual({ carried: 1, skipped: { "message:compactionSummary": 1 } });
			const text = await readFile(path, "utf8");
			expect(text).not.toContain("before");
			expect(text).not.toContain("\"text\":\"reply\"");
		} finally {
			await opened.close();
		}
	});
});
