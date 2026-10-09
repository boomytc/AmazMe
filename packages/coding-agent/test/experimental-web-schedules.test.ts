import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { afterEach, describe, expect, test } from "vitest";
import { createSchedulesService } from "../plugins/automation/src/runtime.ts";
import type { SchedulesState } from "../src/core/plugins/schedules.ts";

/**
 * The schedule store over its real file and a clock the test moves: what lands in
 * `schedules.json`, which runs the tick performs, and what each run records.
 */
const directories = new Set<string>();
const stores = new Set<ReturnType<typeof createSchedulesService>>();

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all([...stores].map((store) => store.stop()));
	stores.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

interface Store {
	readonly path: string;
	readonly state: ReturnType<typeof replicatedState<SchedulesState>>;
	readonly service: ReturnType<typeof createSchedulesService>;
	/** Move the store's clock, then return its value. */
	advance(ms: number): number;
	/** Every run the default runner performed, in order. */
	readonly runs: { readonly sessionId: string; readonly prompt: string }[];
	/** Make every later run of the default runner throw. */
	readonly failure: { on: boolean };
	recordFile(): Promise<{ schedules: readonly Record<string, unknown>[] }>;
}

async function openStore(
	runner?: (sessionId: string, prompt: string) => Promise<string>,
	tickMs = 1_000,
): Promise<Store> {
	const agentDir = await makeDirectory("web-schedules-");
	const state = replicatedState<SchedulesState>({ revision: 0, path: "", tickMs: 0, problem: null, schedules: [] });
	const runs: { sessionId: string; prompt: string }[] = [];
	const failure = { on: false };
	let clock = 1_000_000;
	const service = createSchedulesService(
		{
			agentDir: () => agentDir,
			hostId: () => "test-host",
			cancel: async () => null,
			now: () => clock,
			tickMs,
			run: async (sessionId, request, accepted) => {
				await accepted("1");
				if (runner !== undefined) await runner(sessionId, request.message);
				else {
					runs.push({ sessionId, prompt: request.message });
					if (failure.on) throw new Error("the model is unavailable");
				}
				return { status: "done", text: "", reason: null };
			},
		},
		() => state,
	);
	stores.add(service);
	await service.activate(BACKGROUND_CONTEXT);
	const path = join(agentDir, "schedules.json");
	return {
		path,
		state,
		service,
		advance: (ms) => (clock += ms),
		runs,
		failure,
		async recordFile() {
			return JSON.parse(await readFile(path, "utf8")) as { schedules: readonly Record<string, unknown>[] };
		},
	};
}

describe("planned prompts", () => {
	test("adds a schedule, runs it when due, and records what the run produced", async () => {
		const store = await openStore();
		expect(store.state.value?.path).toBe(store.path);

		// The prompt is trimmed, the cadence becomes milliseconds, and the first run is one gap away.
		expect(
			await store.service.service.add(
				{ conversationId: "1", sessionId: "session-1", prompt: "  report the changes  ", everyMinutes: 2 },
				BACKGROUND_CONTEXT,
			),
		).toEqual({ ok: true, note: "Added. It runs on its own from now on." });
		expect(store.state.value?.schedules[0]).toMatchObject({
			sessionId: "session-1",
			prompt: "report the changes",
			everyMs: 120_000,
			enabled: true,
			createdAt: 1_000_000,
			lastRunAt: null,
			lastOutcome: null,
			nextRunAt: 1_120_000,
		});
		// The file the CLI would read carries it, not only the replicated state.
		expect((await store.recordFile()).schedules).toHaveLength(1);
		expect((await store.recordFile()).schedules[0]).toMatchObject({ prompt: "report the changes" });

		// Not due yet: the tick leaves it alone.
		store.advance(119_000);
		await store.service.tick(BACKGROUND_CONTEXT);
		expect(store.runs).toHaveLength(0);

		// Due: the tick runs the prompt against its session and records the outcome and the next run.
		store.advance(1_000);
		await store.service.tick(BACKGROUND_CONTEXT);
		expect(store.runs).toEqual([{ sessionId: "session-1", prompt: "report the changes" }]);
		expect(store.state.value?.schedules[0]).toMatchObject({
			lastRunAt: 1_120_000,
			lastOutcome: "Answered.",
			nextRunAt: 1_240_000,
		});
		expect((await store.recordFile()).schedules[0]).toMatchObject({ lastOutcome: "Answered." });

		// A run that throws is reported as the outcome instead of escaping the tick.
		store.failure.on = true;
		store.advance(120_000);
		await store.service.tick(BACKGROUND_CONTEXT);
		expect(store.runs).toHaveLength(2);
		expect(store.state.value?.schedules[0]?.pending?.problem).toBe("the model is unavailable");

		await store.service.stop();
	}, 30_000);

	test("runs a due prompt from the host's own timer", async () => {
		const store = await openStore(undefined, 20);
		await store.service.service.add({ conversationId: "1", sessionId: "s", prompt: "timer", everyMinutes: 1 }, BACKGROUND_CONTEXT);
		// The clock moves past the due time, then the host's own loop is what runs it.
		store.advance(60_000);
		store.service.start();
		try {
			await waitFor(() => store.runs.length === 1, "the timer's run");
		} finally {
			store.service.stop();
		}
		expect(store.runs).toEqual([{ sessionId: "s", prompt: "timer" }]);
		expect(store.state.value?.tickMs).toBe(20);
		// Once stopped, an overdue schedule is left alone.
		store.advance(120_000);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(store.runs).toHaveLength(1);
	}, 30_000);

	test("starts one pass at a time, so a run in flight is not doubled", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered: string[] = [];
		const store = await openStore(async (sessionId, prompt) => {
			entered.push(`${sessionId}:${prompt}`);
			await gate;
			return "Answered.";
		});
		expect(
			await store.service.service.add({ conversationId: "1", sessionId: "s", prompt: "slow", everyMinutes: 1 }, BACKGROUND_CONTEXT),
		).toMatchObject({ ok: true });
		store.advance(60_000);

		const first = store.service.tick(BACKGROUND_CONTEXT);
		await waitFor(() => entered.length === 1, "the first run's file checks and admission");
		// The second pass starts while the first is inside its run: it returns without running again.
		await store.service.tick(BACKGROUND_CONTEXT);
		expect(entered).toHaveLength(1);
		release?.();
		await first;
		expect(entered).toHaveLength(1);
		expect(store.state.value?.schedules[0]?.lastOutcome).toBe("Answered.");
	}, 30_000);

	test("pauses, resumes, runs on demand, and removes a schedule", async () => {
		const store = await openStore();
		expect(
			await store.service.service.add({ conversationId: "1", sessionId: "session-2", prompt: "check the queue", everyMinutes: 5 }, BACKGROUND_CONTEXT),
		).toMatchObject({ ok: true });
		const id = store.state.value?.schedules[0]?.id ?? "";
		expect(id.length).toBeGreaterThan(0);

		// A paused schedule is skipped by the tick even once its due time passes.
		expect(await store.service.service.setEnabled(id, false, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			note: "Paused.",
		});
		expect(store.state.value?.schedules[0]?.enabled).toBe(false);
		store.advance(600_000);
		await store.service.tick(BACKGROUND_CONTEXT);
		expect(store.runs).toHaveLength(0);

		// Run now works while it is paused, and records the outcome without moving the cadence.
		const pausedNextRun = store.state.value?.schedules[0]?.nextRunAt;
		expect(await store.service.service.runNow(id, randomUUID(), BACKGROUND_CONTEXT)).toEqual({ ok: true, note: "Answered." });
		expect(store.runs).toEqual([{ sessionId: "session-2", prompt: "check the queue" }]);
		expect(store.state.value?.schedules[0]).toMatchObject({ lastRunAt: 1_600_000, lastOutcome: "Answered." });
		expect(store.state.value?.schedules[0]?.nextRunAt).toBe(pausedNextRun);

		// Resuming re-arms the next run from now.
		expect(await store.service.service.setEnabled(id, true, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			note: "Running again.",
		});
		expect(store.state.value?.schedules[0]?.nextRunAt).toBe(1_600_000 + 300_000);

		// A manual run while it is running does not move that cadence either; only the tick does.
		store.advance(60_000);
		expect(await store.service.service.runNow(id, randomUUID(), BACKGROUND_CONTEXT)).toEqual({ ok: true, note: "Answered." });
		expect(store.state.value?.schedules[0]).toMatchObject({ lastRunAt: 1_660_000, nextRunAt: 1_900_000 });
		// Once it is due, the tick runs it again and moves the next run on from the run's finish.
		store.advance(240_000);
		await store.service.tick(BACKGROUND_CONTEXT);
		expect(store.runs).toHaveLength(3);
		expect(store.state.value?.schedules[0]).toMatchObject({ lastRunAt: 1_900_000, nextRunAt: 2_200_000 });

		// A manual run of a schedule that is gone reports it rather than failing the call.
		expect(await store.service.service.runNow("no-such-schedule", randomUUID(), BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
		expect(await store.service.service.setEnabled("no-such-schedule", false, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
		});

		await store.service.service.remove(id, BACKGROUND_CONTEXT);
		expect(store.state.value?.schedules).toEqual([]);
		expect((await store.recordFile()).schedules).toEqual([]);
	}, 30_000);

	test("refuses a prompt or a cadence the store cannot keep", async () => {
		const store = await openStore();
		const add = store.service.service.add;
		expect(await add({ conversationId: "1", sessionId: "s", prompt: "   ", everyMinutes: 5 }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
		});
		expect(await add({ conversationId: "1", sessionId: "", prompt: "hello", everyMinutes: 5 }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
		});
		expect(await add({ conversationId: "1", sessionId: "s", prompt: "hello", everyMinutes: 0 }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
		});
		expect(await add({ conversationId: "1", sessionId: "s", prompt: "hello", everyMinutes: Number.NaN }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
		});
		expect(store.state.value?.schedules).toEqual([]);
	}, 30_000);

	test("re-reads the file, and an unreadable file is empty rather than fatal", async () => {
		const store = await openStore();
		await writeFile(
			store.path,
			JSON.stringify({
				version: 2,
				hostId: "test-host",
				schedules: [
					{
						id: "kept",
						conversationId: "1", pending: null, history: [],
						sessionId: "session-3",
						prompt: "keep me",
						everyMs: 60_000,
						enabled: true,
						createdAt: 5,
						lastRunAt: null,
						lastOutcome: null,
						nextRunAt: 65_000,
					},
					{ nonsense: true },
					{ id: "bad", sessionId: "s", prompt: "x", everyMs: 0, enabled: true, createdAt: 1, nextRunAt: 2 },
				],
			}),
			"utf8",
		);
		await store.service.service.reload(BACKGROUND_CONTEXT);
		expect(store.state.value?.schedules.map((schedule) => schedule.id)).toEqual(["kept"]);

		await writeFile(store.path, "{ not json", "utf8");
		await store.service.service.reload(BACKGROUND_CONTEXT);
		expect(store.state.value?.schedules).toEqual([]);

		await rm(store.path, { force: true });
		await store.service.service.reload(BACKGROUND_CONTEXT);
		expect(store.state.value?.schedules).toEqual([]);
		// Adding after the file went away recreates it.
		expect(
			await store.service.service.add({ conversationId: "1", sessionId: "s", prompt: "again", everyMinutes: 1 }, BACKGROUND_CONTEXT),
		).toMatchObject({ ok: true });
		expect((await store.recordFile()).schedules).toHaveLength(1);
	}, 30_000);
});
