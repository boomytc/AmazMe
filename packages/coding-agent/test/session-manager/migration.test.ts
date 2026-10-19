import { describe, expect, it } from "vitest";
import { type FileEntry, migrateSessionEntries } from "../../src/core/jsonl-transcript.ts";

describe("migrateSessionEntries", () => {
	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have version set (v3 is current after hookMessage->custom migration)
		expect((entries[0] as any).version).toBe(3);

		// Entries should have id/parentId
		const msg1 = entries[1] as any;
		const msg2 = entries[2] as any;

		expect(msg1.id).toBeDefined();
		expect(msg1.id.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("renames hookMessage when migrating v2 and keeps existing ids", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "note", timestamp: 1 },
			},
		];
		const legacy = entries[1];
		if (legacy?.type !== "message") throw new Error("expected a message");
		(legacy.message as { role: string }).role = "hookMessage";

		migrateSessionEntries(entries);

		const header = entries[0];
		const message = entries[1];
		if (header?.type !== "session" || message?.type !== "message") throw new Error("expected a v2 session");
		expect(header.id).toBe("sess-1");
		expect(header.version).toBe(3);
		expect(message.id).toBe("abc12345");
		expect(message.parentId).toBeNull();
		expect(message.message.role).toBe("custom");
	});

	it("skips sessions that are already at the current version", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 3, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		const header = entries[0];
		const first = entries[1];
		const second = entries[2];
		if (header?.type !== "session" || first?.type !== "message" || second?.type !== "message") {
			throw new Error("expected a current session");
		}
		expect(header.id).toBe("sess-1");
		expect(header.version).toBe(3);
		expect(first.id).toBe("abc12345");
		expect(second.id).toBe("def67890");
		expect(second.parentId).toBe("abc12345");
	});
});
