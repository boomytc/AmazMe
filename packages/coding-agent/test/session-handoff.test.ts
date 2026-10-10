import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { UserMessage } from "@amazme/ai";
import { UserEntry } from "@amazme/durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../src/core/messages.ts";
import { sessionEntriesToDurableDrafts } from "../src/core/session-interop.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { FileEntry, SessionEntry } from "../src/core/session-manager.ts";
import { startSessionHandoff } from "../src/host/session-handoff.ts";
import type { SessionHandoff, SessionHandoffOptions } from "../src/host/session-handoff.ts";
import { deleteLocalSessionFiles, listLocalSessions, mirrorPath, writeSessionMirror } from "../src/host/session-store.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";
import type { FauxConversation } from "./experimental-durable-support.ts";

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});

const timestamp = "2026-10-07T00:00:00.000Z";
const createdAt = Date.parse(timestamp);
const id = "handoff-session";
const userText = "hello from the terminal";
const user: UserMessage = { role: "user", content: userText, timestamp: 1 };
function entry(entryId: string, parentId: string | null = null, message = user): SessionEntry {
	return { type: "message", id: entryId, parentId, timestamp, message };
}

describe("terminal and durable handoff contract", () => {
	let directory: string;
	let cwd: string;
	let opened: FauxConversation;
	let handoff: SessionHandoff | undefined;
	let reports: string[];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-handoff-"));
		cwd = join(directory, "project");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", join(directory, "profile"));
		opened = await openFauxConversation();
		reports = [];
	});

	afterEach(async () => {
		await handoff?.dispose();
		handoff = undefined;
		await opened.close();
		vi.mocked(rename).mockClear();
		vi.mocked(writeFile).mockClear();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	async function terminal(entries: readonly SessionEntry[], sessionId = id, project = cwd): Promise<string> {
		const path = mirrorPath(project, sessionId, createdAt);
		const lines: readonly FileEntry[] = [{ type: "session", version: 3, id: sessionId, cwd: project, timestamp }, ...entries];
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
		return path;
	}

	async function start(overrides: Pick<SessionHandoffOptions, "sessionName"> = {}): Promise<void> {
		handoff = await startSessionHandoff({ conversation: opened.conversation, sessionId: id, cwd, createdAt, report: (line) => reports.push(line), ...overrides });
		await handoff.refresh();
	}

	async function messages() {
		return (await opened.conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
	}

	it("seeds only an empty durable conversation from the same id and project", async () => {
		await terminal([entry("terminal-1")]);
		await terminal([entry("other-1", null, { ...user, content: "other id" })], "other-id");
		await start();
		expect((await messages()).map((item) => item.model)).toEqual([[user]]);
		expect(reports).toContainEqual(expect.stringContaining("1 carried"));
		expect(SessionManager.open(mirrorPath(cwd, id, createdAt)).getSessionId()).toBe(id);
	});

	it("does not seed an existing durable transcript or overwrite a divergent terminal file", async () => {
		await terminal([entry("terminal-1")]);
		await opened.conversation.submit({ type: "write", entry: { kind: UserEntry.kind, model: [{ ...user, content: "durable wins" }] } }, BACKGROUND_CONTEXT);
		await start();
		expect((await messages()).map((item) => item.model?.[0])).toEqual([{ ...user, content: "durable wins" }]);
		expect(reports.some((line) => line.includes("started from"))).toBe(false);
		expect(SessionManager.open(mirrorPath(cwd, id, createdAt)).getEntries()).toEqual([entry("terminal-1")]);
		expect(handoff?.warning?.detail).toContain("differs");
	});

	it("does not seed from a different terminal id", async () => {
		await terminal([entry("other-1")], "other-id");
		await start();
		expect(await messages()).toEqual([]);
		expect(reports.some((line) => line.includes("started from"))).toBe(false);
	});

	it("refuses lossy import and mirroring of a terminal tree and metadata", async () => {
		const base = { timestamp };
		const entries: SessionEntry[] = [
			entry("root"),
			entry("left", "root", { ...user, content: "left branch" }),
			entry("right", "root", { ...user, content: "right branch" }),
			{ ...base, type: "model_change", id: "model", parentId: "right", provider: "fixture", modelId: "fixture" },
			{ ...base, type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "high" },
			{ ...base, type: "label", id: "label", parentId: "thinking", targetId: "left", label: "bookmark" },
			{ ...base, type: "session_info", id: "name", parentId: "label", name: "Terminal name" },
			{ ...base, type: "custom", id: "custom", parentId: "name", customType: "fixture", data: { important: true } },
			{ ...base, type: "custom_message", id: "custom-message", parentId: "custom", customType: "fixture", content: "extension context", display: true },
			{ ...base, type: "branch_summary", id: "summary", parentId: "custom-message", fromId: "left", summary: "left branch summary" },
		];
		const path = await terminal(entries);
		const original = await readFile(path, "utf8");
		await start();
		const mirrored = SessionManager.open(path).getEntries();
		expect(await readFile(path, "utf8")).toBe(original);
		expect(mirrored).toEqual(entries);
		expect(await messages()).toEqual([]);
		expect(handoff?.warning?.detail).toContain("branch tree");
		await opened.conversation.submit({ type: "write", entry: { kind: UserEntry.kind, model: [user] } }, BACKGROUND_CONTEXT);
		await handoff?.refresh();
		expect(await readFile(path, "utf8")).toBe(original);
		expect(reports).toContainEqual(expect.stringContaining("skipped model_change×1"));
		expect(reports).toContainEqual(expect.stringContaining("branch_summary×1"));
	});

	it("round trips the supported message subset and writes stable ids for the same durable entries", async () => {
		const path = await terminal([entry("terminal-1"), entry("terminal-2", "terminal-1", { ...user, content: "second message", timestamp: 2 })]);
		await start();
		const first = await readFile(path, "utf8");
		await handoff?.refresh();
		expect(await readFile(path, "utf8")).toBe(first);
		const manager = SessionManager.open(path);
		expect(manager.getSessionId()).toBe(id);
		expect(manager.getEntries().map((item) => item.id)).not.toEqual(["terminal-1", "terminal-2"]);
		const second = await openFauxConversation();
		try {
			const projection = sessionEntriesToDurableDrafts(manager.getEntries());
			for (const draft of projection.drafts) await second.conversation.submit({ type: "write", entry: draft }, BACKGROUND_CONTEXT);
			const restored = await second.conversation.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
			expect(restored.items.map((item) => ({ kind: item.kind, model: item.model }))).toEqual((await messages()).map((item) => ({ kind: item.kind, model: item.model })));
		} finally { await second.close(); }
	});

	it("reports failed mirroring and leaves the original file intact", async () => {
		const path = await terminal([entry("terminal-1")]);
		const original = await readFile(path, "utf8");
		vi.mocked(rename).mockRejectedValue(new Error("fixture rename failure"));
		try {
			await start();
			expect(reports).toContainEqual(expect.stringContaining("fixture rename failure"));
			expect(await readFile(path, "utf8")).toBe(original);
			expect((await readdir(dirname(path))).some((name) => name.includes(".tmp-"))).toBe(false);
		} finally { vi.mocked(rename).mockRestore(); }
	});

	it("cleans a partially written temporary file when writing fails", async () => {
		const path = await terminal([entry("terminal-1")]);
		const original = await readFile(path, "utf8");
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(writeFile).mockImplementation(async (...args) => {
			await actual.writeFile(...args);
			throw new Error("fixture partial write failure");
		});
		try {
			await start();
			expect(await readFile(path, "utf8")).toBe(original);
			expect((await readdir(dirname(path))).some((name) => name.includes(".tmp-"))).toBe(false);
			expect(handoff?.warning?.detail).toContain("partial write failure");
		} finally { vi.mocked(writeFile).mockRestore(); }
	});

	it.each(["append", "replace", "truncate", "delete", "recreate", "touch"] as const)(
		"never resumes overwriting after an external %s",
		async (operation) => {
			const path = await terminal([entry("terminal-1")]);
			await start();
			const subscribers: (string | null)[] = [];
			const stop = handoff?.subscribeWarning((warning) => subscribers.push(warning?.detail ?? null));
			const own = await readFile(path, "utf8");
			if (operation === "append") await writeFile(path, own + JSON.stringify(entry("external", "unknown")) + "\\n");
			if (operation === "replace") {
				const external = path + ".external";
				await writeFile(external, own);
				await rename(external, path);
			}
			if (operation === "truncate") await writeFile(path, "");
			if (operation === "delete" || operation === "recreate") await rm(path);
			if (operation === "recreate") await writeFile(path, "external replacement");
			if (operation === "touch") {
				const current = await stat(path);
				await utimes(path, current.atime, new Date(current.mtimeMs + 1000));
			}
			const external = await readFile(path, "utf8").catch(() => undefined);
			await opened.conversation.submit({ type: "write", entry: { kind: UserEntry.kind, model: [{ ...user, content: "new durable revision" }] } }, BACKGROUND_CONTEXT);
			await handoff?.refresh();
			expect(handoff?.warning).not.toBeNull();
			expect(subscribers.at(-1)).not.toBeNull();
			expect(reports).toContainEqual(expect.stringContaining("original file preserved"));
			await handoff?.refresh();
			await handoff?.dispose();
			expect(await readFile(path, "utf8").catch(() => undefined)).toBe(external);
			stop?.();
		},
	);

	it("does not overwrite a file created during the first mirror", async () => {
		const path = mirrorPath(cwd, id, createdAt);
		let created = false;
		await start({ sessionName: async () => {
			if (!created) { created = true; await writeFile(path, "external first writer"); }
			return undefined;
		} });
		expect(await readFile(path, "utf8")).toBe("external first writer");
		expect(handoff?.warning).not.toBeNull();
	});

	it("will not follow a terminal-file symlink", async () => {
		const path = await terminal([entry("terminal-1")]);
		const target = join(directory, "external.jsonl");
		const original = await readFile(path, "utf8");
		await writeFile(target, original);
		await rm(path);
		await symlink(target, path);
		await start();
		expect(handoff?.warning?.detail).toContain("regular file");
		expect(await readFile(target, "utf8")).toBe(original);
	});

	it("write failures do not replace an existing target", async () => {
		const parent = join(directory, "not-a-directory");
		await writeFile(parent, "original");
		await expect(writeSessionMirror({ path: join(parent, "session.jsonl"), guard: { expected: undefined }, sessionId: id, cwd, createdAt, entries: [] })).rejects.toThrow();
		expect(await readFile(parent, "utf8")).toBe("original");
	});

	it.each(["old-version", "malformed-line", "extra-header", "extra-entry", "reserved-summary"] as const)("preserves unsupported captured bytes without migration (%s)", async (kind) => {
		const path = await terminal([entry("terminal-1")]);
		let content = await readFile(path, "utf8");
		if (kind === "old-version") content = content.replace('"version":3', '"version":2');
		if (kind === "malformed-line") content += "not JSON\n";
		if (kind === "extra-header") content = content.replace('"cwd":', '"extensionState":{"keep":true},"cwd":');
		if (kind === "extra-entry") content = content.replace('"parentId":', '"extensionState":{"keep":true},"parentId":');
		if (kind === "reserved-summary") content = content.replace(userText, COMPACTION_SUMMARY_PREFIX + "literal user input" + COMPACTION_SUMMARY_SUFFIX);
		await writeFile(path, content);
		await start();
		expect(await readFile(path, "utf8")).toBe(content);
		expect(await messages()).toEqual([]);
		expect(handoff?.warning).not.toBeNull();
	});

	it("deletes all matching files only in the requested project", async () => {
		const path = await terminal([entry("terminal-1")]);
		const duplicate = join(dirname(path), "duplicate.jsonl");
		await writeFile(duplicate, await readFile(path));
		const otherId = await terminal([entry("other")], "other-id");
		const otherCwd = join(directory, "another-project");
		await mkdir(otherCwd);
		const otherProject = await terminal([entry("other-project")], id, otherCwd);
		await deleteLocalSessionFiles(cwd, id);
		expect(await listLocalSessions(cwd)).toHaveLength(1);
		expect(await readFile(otherId, "utf8")).toContain("other-id");
		expect(await readFile(otherProject, "utf8")).toContain(id);
		await expect(readFile(path)).rejects.toThrow();
		await expect(readFile(duplicate)).rejects.toThrow();
	});
});
