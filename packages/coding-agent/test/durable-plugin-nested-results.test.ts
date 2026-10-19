import { createModels, fauxAssistantMessage, fauxProvider, fauxText, Type } from "@amazme/ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, type HarnessOptions, MemoryStorage, NestedCallDoc, type SetTimer, type Storage, type TaskId } from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "../plugins/verification/src/check.ts";
import { Verification } from "../plugins/verification/src/session.ts";
import { PolicyDoc, Rounds } from "../plugins/verification/src/state.ts";
import { Command } from "../plugins/workflows/src/command.ts";
import { Job } from "../plugins/workflows/src/job.ts";
import { pendingResponse } from "./experimental-durable-support.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.close(context)));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function open(exitCode: number, options: Pick<HarnessOptions, "setTimer" | "now"> & { readonly hang?: boolean; readonly storage?: Storage } = {}) {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	let calls = 0;
	registry.install(
		defineExtension({
			name: "commands",
			tasks: [Command, Job],
			tools: [
				defineTool({
					name: "bash",
					description: "Fake command",
					parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
					structuredOutputSchema: Type.Object({ output: Type.String(), exitCode: Type.Number() }),
					execute: async (_arguments, _api, context) => {
						calls++;
						if (options.hang) await new Promise<never>((_resolve, reject) => {
							const signal = context.abortSignal!;
							if (signal.aborted) reject(signal.reason);
							else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						});
						return {
							output: [{ type: "text", text: "command evidence" }],
							structuredOutput: { output: "command evidence", exitCode },
							details: { exit_code: exitCode },
							isError: exitCode !== 0,
						};
					},
				}),
			],
		}),
	);
	registry.install(Verification);
	const reports: unknown[] = [];
	const harness = await Harness.open(
		options.storage ?? new MemoryStorage(),
		{ models, registry, now: options.now, setTimer: options.setTimer, onReport: (error) => reports.push(error) },
		context,
	);
	harnesses.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { harness, root, faux, reports, calls: () => calls };
}

function clock() {
	let now = 1000;
	const foreground = new Map<() => void, number>();
	const setTimer: SetTimer = (callback, delayMs, { background }) => {
		if (background) return undefined;
		foreground.set(callback, now + delayMs);
		return () => { foreground.delete(callback); };
	};
	return { now: () => now, setTimer, foreground, advance: (ms: number) => { now += ms; } };
}

async function startCommand(kind: "job" | "check", root: Awaited<ReturnType<typeof open>>["root"]) {
	return kind === "job"
		? root.commit((tx) => tx.createTask(Job, {
			spec: { kind: "command", name: "timeout", tool: "bash", command: "fake" },
			stage: 0, job: 0, role: "verify", objective: "test", args: "", evidence: [],
			timeoutSeconds: 60, model: null, instructions: "", allowed: ["bash"],
		}, { ownership: { kind: "conversation" } }), context)
		: root.commit((tx) => tx.createTask(Check, {
			candidate: { text: "candidate", limited: false, stopReason: "stop" },
			checks: [{ name: "check", command: "fake", tool: "bash" as const }], timeoutSeconds: 60,
		}, { ownership: { kind: "conversation" } }), context);
}

describe("plugins read nested results by call key", () => {
	it.each(["job", "check"] as const)("%s deadlines abort owned work and release their phase timers", async (kind) => {
		const time = clock();
		const { harness, root, reports, calls } = await open(0, { ...time, hang: true });
		const id = await startCommand(kind, root);
		const settled = harness.waitForTask(id as TaskId, context);
		await vi.waitFor(() => { expect(calls()).toBe(1); expect(time.foreground.size).toBe(1); });
		time.advance(60_000);
		for (const [callback, at] of time.foreground) {
			if (at <= time.now()) { time.foreground.delete(callback); callback(); }
		}
		expect(await settled).toMatchObject({
			state: { outcome: { status: "completed", result: { status: "timed_out" } } },
		});
		expect(time.foreground.size).toBe(0);
		expect(reports).toEqual([]);
	});

	it.each(["job", "check"] as const)("%s rechecks an early timer and cancels without retaining it", async (kind) => {
		const time = clock();
		const { harness, root, reports, calls } = await open(0, { ...time, hang: true });
		const id = await startCommand(kind, root);
		const settled = harness.waitForTask(id as TaskId, context);
		await vi.waitFor(() => { expect(calls()).toBe(1); expect(time.foreground.size).toBe(1); });
		const early = time.foreground.keys().next().value!;
		time.foreground.delete(early);
		early();
		expect([...time.foreground.values()]).toEqual([61_000]);
		expect((await harness.getTask(id as TaskId, context))?.abortRequested).toBe(false);
		await harness.abortTask(id as TaskId, context);
		expect(await settled).toMatchObject({ state: { outcome: { status: "aborted", result: { status: "cancelled" } } } });
		expect(time.foreground.size).toBe(0);
		expect(reports).toEqual([]);
	});

	it.each(["job", "check"] as const)("%s keeps its deadline and does not replay an interrupted unsafe command after reopen", async (kind) => {
		const directory = await mkdtemp(join(tmpdir(), "amazme-plugin-deadline-"));
		directories.push(directory);
		const path = join(directory, "session.sqlite");
		const time = clock();
		const first = await open(0, { ...time, hang: true, storage: await openNodeSqliteStorage(path) });
		const id = await startCommand(kind, first.root);
		first.harness.resume();
		await vi.waitFor(() => { expect(first.calls()).toBe(1); expect(time.foreground.size).toBe(1); });
		await first.harness.close(context);
		expect(time.foreground.size).toBe(0);
		time.advance(60_001);
		const second = await open(0, { ...time, storage: await openNodeSqliteStorage(path) });
		const settled = await second.harness.waitForTask(id as TaskId<{ status: string }>, context);
		expect(settled.state.outcome.status).toBe("completed");
		// Deadline cancellation and the interrupted-tool receipt may race; neither verifies completion.
		expect(kind === "job" ? ["timed_out", "unverified"] : ["unverified"]).toContain(settled.state.outcome.result?.status);
		expect(first.calls()).toBe(1);
		expect(second.calls()).toBe(0);
		expect(time.foreground.size).toBe(0);
		expect([...first.reports, ...second.reports]).toEqual([]);
	});

	it("agent job deadlines abort their owned conversation and release timers", async () => {
		const time = clock();
		const { harness, root, faux, reports } = await open(0, time);
		const pending = pendingResponse();
		faux.setResponses([pending.step]);
		const id = await root.commit((tx) => tx.createTask(Job, {
			spec: { kind: "agent", name: "timeout", prompt: "work", tools: [] },
			stage: 0, job: 0, role: "work", objective: "test", args: "", evidence: [],
			timeoutSeconds: 60, model: { provider: "faux", modelId: "faux-1" }, instructions: "", allowed: [],
		}, { ownership: { kind: "conversation" } }), context);
		const settled = harness.waitForTask(id, context);
		await pending.reached;
		await vi.waitFor(() => { expect(time.foreground.size).toBe(1); });
		time.advance(60_000);
		for (const [callback, at] of time.foreground) {
			if (at <= time.now()) { time.foreground.delete(callback); callback(); }
		}
		expect(await settled).toMatchObject({ state: { outcome: { status: "completed", result: { status: "timed_out" } } } });
		expect(time.foreground.size).toBe(0);
		const graph = await harness.taskGraph(context);
		try { expect(Object.values(graph.value.tasks)).toEqual([]); }
		finally { graph.dispose(); }
		expect(reports).toEqual([]);
	});

	it.each([0, 7])("workflow commands and jobs keep exit evidence (%s)", async (exitCode) => {
		const { harness, root, reports, calls } = await open(exitCode);
		const command = await root.commit(
			(tx) =>
				tx.createTask(
					Command,
					{
						callId: "command",
						name: "bash",
						args: { command: "fake" },
					},
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		expect((await harness.waitForTask(command, context)).state.outcome.result?.isError).toBe(exitCode !== 0);
		const job = await root.commit(
			(tx) =>
				tx.createTask(
					Job,
					{
						spec: { kind: "command", name: "test", tool: "bash", command: "fake" },
						stage: 0,
						job: 0,
						role: "verify",
						objective: "test",
						args: "",
						evidence: [],
						timeoutSeconds: 60,
						model: null,
						instructions: "",
						allowed: ["bash"],
					},
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		expect((await harness.waitForTask(job, context)).state.outcome.result).toMatchObject({
			status: exitCode === 0 ? "passed" : "failed",
			text: "command evidence",
		});
		expect(calls()).toBe(2);
		expect(reports).toEqual([]);
		expect(await harness.snapshot(NestedCallDoc, job, "command", context)).toBeUndefined();
	});

	it.each([0, 7])("verification checks retain command output and exit code (%s)", async (exitCode) => {
		const { harness, root, reports } = await open(exitCode);
		const check = await root.commit(
			(tx) =>
				tx.createTask(
					Check,
					{
						candidate: { text: "candidate", limited: false, stopReason: "stop" },
						checks: [{ name: "check", command: "fake", tool: "bash" as const }],
						timeoutSeconds: 60,
					},
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		expect((await harness.waitForTask(check, context)).state.outcome.result).toMatchObject({
			status: exitCode === 0 ? "passed" : "failed",
			checks: [{ status: exitCode === 0 ? "passed" : "failed", exitCode, output: "command evidence" }],
		});
		expect(reports).toEqual([]);
	});

	it("verification receipts still allow the configured corrective round after failed checks", async () => {
		const { harness, root, faux, reports, calls } = await open(7);
		await root.commit(async (tx) => {
			const policy = await tx.doc(PolicyDoc, root.id);
			policy.enabled = true;
			policy.checks = [{ name: "test", command: "fake", tool: "bash" }];
			policy.maxCorrections = 1;
		}, context);
		faux.setResponses([fauxAssistantMessage([fauxText("candidate")]), fauxAssistantMessage([fauxText("corrected")])]);
		expect((await (await root.submit({ type: "input", content: "work" }, context)).wait(context)).status).toBe("done");
		const state = await harness.snapshot(Rounds, root.id, context);
		expect(state?.correctiveRequests).toBe(1);
		expect(state?.rounds).toHaveLength(2);
		expect(calls()).toBe(2);
		for (const round of state?.rounds ?? []) {
			expect(round.receipt).not.toBeNull();
			expect((await harness.getTask(round.receipt!, context))?.state.outcome?.status).toBe("completed");
		}
		expect(reports).toEqual([]);
	});
});
