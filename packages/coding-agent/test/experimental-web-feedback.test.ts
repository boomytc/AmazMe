import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { afterEach, describe, expect, test } from "vitest";
import { createFeedbackService } from "../src/experimental/services/feedback-provider.ts";
import type { FeedbackState } from "../src/experimental/services/feedback.ts";

/**
 * The ratings store, over its real file: a rating lands in `feedback.json`, re-rating replaces it,
 * withdrawing removes it, and the file is read back rather than trusted from memory.
 */
const directories = new Set<string>();

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

async function openStore(): Promise<{
	readonly agentDir: string;
	readonly path: string;
	readonly state: ReturnType<typeof replicatedState<FeedbackState>>;
	readonly service: ReturnType<typeof createFeedbackService>;
	readFile(): Promise<{ records: readonly Record<string, unknown>[] }>;
}> {
	const agentDir = await makeDirectory("web-feedback-");
	const state = replicatedState<FeedbackState>({ revision: 0, path: "", records: [] });
	const service = createFeedbackService({ agentDir }, () => state);
	await service.activate(BACKGROUND_CONTEXT);
	return {
		agentDir,
		path: join(agentDir, "feedback.json"),
		state,
		service,
		async readFile() {
			return JSON.parse(await readFile(join(agentDir, "feedback.json"), "utf8")) as {
				records: readonly Record<string, unknown>[];
			};
		},
	};
}

const REQUEST = { sessionId: "session-1", conversationId: "1", entryId: "12" } as const;

describe("message feedback", () => {
	test("rates an answer, replaces the rating, and withdraws it", async () => {
		const store = await openStore();
		expect(store.state.value?.path).toBe(store.path);
		expect(store.state.value?.records).toEqual([]);

		expect(await store.service.service.rate({ ...REQUEST, rating: "up" }, BACKGROUND_CONTEXT)).toEqual({ ok: true });
		expect(store.state.value?.records).toHaveLength(1);
		expect(store.state.value?.records[0]).toMatchObject({ ...REQUEST, rating: "up", note: null });
		// The rating is on disk, not only in memory.
		expect((await store.readFile()).records).toHaveLength(1);
		expect((await store.readFile()).records[0]).toMatchObject({ entryId: "12", rating: "up" });

		// Rating the same answer again replaces it rather than adding a second record.
		expect(
			await store.service.service.rate({ ...REQUEST, rating: "down", note: "  missed the point  " }, BACKGROUND_CONTEXT),
		).toEqual({ ok: true });
		expect(store.state.value?.records).toHaveLength(1);
		expect(store.state.value?.records[0]).toMatchObject({ rating: "down", note: "missed the point" });

		// A different answer is a separate record, newest first.
		expect(
			await store.service.service.rate({ sessionId: "session-1", conversationId: "1", entryId: "20", rating: "up" }, BACKGROUND_CONTEXT),
		).toEqual({ ok: true });
		expect(store.state.value?.records.map((record) => record.entryId)).toEqual(["20", "12"]);

		expect(await store.service.service.retract(REQUEST, BACKGROUND_CONTEXT)).toEqual({ ok: true });
		expect(store.state.value?.records.map((record) => record.entryId)).toEqual(["20"]);
		expect((await store.readFile()).records).toHaveLength(1);
		// Withdrawing a rating that is not there reports it instead of failing the call.
		expect(await store.service.service.retract(REQUEST, BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
		// A rating without an answer to belong to is refused.
		expect(
			await store.service.service.rate({ sessionId: "session-1", conversationId: "1", entryId: "", rating: "up" }, BACKGROUND_CONTEXT),
		).toMatchObject({ ok: false });
	}, 30_000);

	test("re-reads the file, and an unreadable file is empty rather than fatal", async () => {
		const store = await openStore();
		await writeFile(
			store.path,
			JSON.stringify({
				version: 1,
				records: [
					{ sessionId: "s", conversationId: "1", entryId: "9", rating: "down", note: null, at: 1 },
					{ nonsense: true },
					{ sessionId: "s", conversationId: "1", entryId: "10", rating: "sideways", at: 2 },
				],
			}),
			"utf8",
		);
		await store.service.service.reload(BACKGROUND_CONTEXT);
		// Only records that name an answer and a rating survive the read.
		expect(store.state.value?.records.map((record) => record.entryId)).toEqual(["9"]);

		await writeFile(store.path, "{ not json", "utf8");
		await store.service.service.reload(BACKGROUND_CONTEXT);
		expect(store.state.value?.records).toEqual([]);

		await rm(store.path, { force: true });
		await store.service.service.reload(BACKGROUND_CONTEXT);
		expect(store.state.value?.records).toEqual([]);
		// Rating after the file went away recreates it.
		expect(await store.service.service.rate({ ...REQUEST, rating: "up" }, BACKGROUND_CONTEXT)).toEqual({ ok: true });
		expect((await store.readFile()).records[0]).toMatchObject({ entryId: "12", rating: "up" });
	}, 30_000);
});
