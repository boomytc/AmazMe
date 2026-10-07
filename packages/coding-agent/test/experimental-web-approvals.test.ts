import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, createModels } from "@amazme/ai";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT, TODO_CONTEXT } from "@amazme/chord/context";
import { createRegistry, Harness, type EntryRecord } from "@amazme/durable";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { CodingTools } from "@amazme/durable/tools";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolApprovalMode } from "../src/core/settings-manager.ts";
import { createApprovalGate, toolNeedsApproval } from "../src/experimental/services/approvals-provider.ts";
import type { ApprovalsState } from "../src/experimental/services/approvals.ts";

/**
 * The approval gate at the tool boundary, over a real Harness: the scripted model asks for a `read`,
 * the gate publishes it as pending, and the decision decides whether the call runs or settles as a
 * blocked tool result the run continues from.
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

async function waitFor(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

/** A harness with the coding tools behind the gate, and a marker file to read. */
async function openGate(mode: ToolApprovalMode): Promise<{
	readonly harness: Harness;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly state: ReturnType<typeof replicatedState<ApprovalsState>>;
	readonly gate: ReturnType<typeof createApprovalGate>;
	readonly markerPath: string;
	readonly marker: string;
	ask(text: string, responses: readonly unknown[]): Promise<void>;
	entries(): Promise<readonly EntryRecord[]>;
	close(): Promise<void>;
}> {
	const directory = await makeDirectory("web-approvals-");
	const marker = `approval-marker-${Date.now()}`;
	const markerPath = join(directory, "notes.txt");
	await writeFile(markerPath, `# notes\n${marker}\n`, "utf8");

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const gate = createApprovalGate({ mode: () => mode });
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(gate.extension);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "session.sqlite")),
		{ models, registry, env: () => new NodeExecutionEnv({ cwd: directory }) },
		TODO_CONTEXT,
	);
	const state = replicatedState<ApprovalsState>({ revision: 0, pending: [] });
	gate.attach(state);
	const root = await harness.root(TODO_CONTEXT, {
		agent: { cwd: directory, model: { provider: "faux", modelId: "faux-1" } },
	});
	return {
		harness,
		faux,
		state,
		gate,
		markerPath,
		marker,
		async ask(text, responses) {
			faux.setResponses(responses as never);
			const submission = await root.submit({ type: "input", content: text }, TODO_CONTEXT);
			await submission.wait(TODO_CONTEXT);
		},
		async entries() {
			const page = await root.entries({}, 200, undefined, TODO_CONTEXT);
			return [...page.items].reverse();
		},
		async close() {
			await harness.close(TODO_CONTEXT);
		},
	};
}

/** Every tool result entry as its text, which is what a reader sees after a decision. */
function toolResultTexts(entries: readonly EntryRecord[]): string[] {
	return entries.flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			message.role === "toolResult" ? [JSON.stringify(message.content)] : [],
		),
	);
}

describe("tool approvals", () => {
	test("asks about the tools a policy marks, and nothing else", () => {
		expect(toolNeedsApproval("off", "bash")).toBe(false);
		expect(toolNeedsApproval("dangerous", "read")).toBe(false);
		expect(toolNeedsApproval("dangerous", "bash")).toBe(true);
		expect(toolNeedsApproval("dangerous", "write")).toBe(true);
		expect(toolNeedsApproval("all", "read")).toBe(true);
	}, 30_000);

	test("denying a call settles it as a blocked result and the turn continues", async () => {
		const setup = await openGate("all");
		try {
			const answered = setup.ask("read the notes", [
				fauxAssistantMessage([fauxToolCall("read", { path: setup.markerPath })], { stopReason: "toolUse" }),
				fauxAssistantMessage("continued after the denial"),
			]);
			void answered;

			// The call itself is published, with the tool and what it would do.
			await waitFor(() => setup.state.value.pending.length === 1, "the pending request");
			const request = setup.state.value.pending[0]!;
			expect(request.tool).toBe("read");
			expect(request.detail).toContain("notes.txt");
			expect(request.taskId.length).toBeGreaterThan(0);
			expect(request.conversationId.length).toBeGreaterThan(0);

			expect(await setup.gate.service().decide(request.id, false, BACKGROUND_CONTEXT)).toBe(true);
			await waitFor(() => setup.state.value.pending.length === 0, "the request to clear");
			await answered;

			const entries = await setup.entries();
			// The denial left a failed tool result, and the file was never read.
			const results = toolResultTexts(entries);
			expect(results.some((text) => text.includes("was not approved"))).toBe(true);
			expect(results.some((text) => text.includes(setup.marker))).toBe(false);
			// The turn continued: the assistant's answer after the denial is committed.
			expect(JSON.stringify(entries.map((entry) => entry.model ?? []))).toContain("continued after the denial");
		} finally {
			await setup.close();
		}
	}, 60_000);

	test("approving a call runs it, and its result reaches the conversation", async () => {
		const setup = await openGate("all");
		try {
			const answered = setup.ask("read the notes", [
				fauxAssistantMessage([fauxToolCall("read", { path: setup.markerPath })], { stopReason: "toolUse" }),
				fauxAssistantMessage("read it"),
			]);
			void answered;
			await waitFor(() => setup.state.value.pending.length === 1, "the pending request");
			const request = setup.state.value.pending[0]!;
			expect(await setup.gate.service().decide(request.id, true, BACKGROUND_CONTEXT)).toBe(true);
			await waitFor(() => setup.state.value.pending.length === 0, "the request to clear");
			await answered;

			const results = toolResultTexts(await setup.entries());
			// The tool really ran: the result carries the file's own bytes.
			expect(results.some((text) => text.includes(setup.marker))).toBe(true);
			expect(await readFile(setup.markerPath, "utf8")).toContain(setup.marker);
		} finally {
			await setup.close();
		}
	}, 60_000);

	test("a policy of off never asks", async () => {
		const setup = await openGate("off");
		try {
			await setup.ask("read the notes", [
				fauxAssistantMessage([fauxToolCall("read", { path: setup.markerPath })], { stopReason: "toolUse" }),
				fauxAssistantMessage("read it"),
			]);
			expect(setup.state.value.pending).toEqual([]);
			expect(toolResultTexts(await setup.entries()).some((text) => text.includes(setup.marker))).toBe(true);
		} finally {
			await setup.close();
		}
	}, 60_000);
});
