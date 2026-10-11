import { createModels, fauxAssistantMessage, fauxProvider, fauxText, Type } from "@amazme/ai";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, NestedCallDoc } from "@amazme/durable";
import { afterEach, describe, expect, it } from "vitest";
import { Check } from "../plugins/verification/src/check.ts";
import { Verification } from "../plugins/verification/src/session.ts";
import { PolicyDoc, Rounds } from "../plugins/verification/src/state.ts";
import { Command } from "../plugins/workflows/src/command.ts";
import { Job } from "../plugins/workflows/src/job.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.close(context)));
});

async function open(exitCode: number) {
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
					execute: async () => {
						calls++;
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
		new MemoryStorage(),
		{ models, registry, onReport: (error) => reports.push(error) },
		context,
	);
	harnesses.push(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { harness, root, faux, reports, calls: () => calls };
}

describe("plugins read nested results by call key", () => {
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
