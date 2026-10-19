import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@amazme/chord";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
	Type,
} from "@amazme/ai";
import {
	defineTool,
	MemoryStorage,
	NestedCallDoc,
	type NestedCallState,
	type NestedToolExecutionResult,
	type ToolExecutionResult,
	type ToolRegistration,
	retainStructuredOutput,
	ToolResultEntry,
	ToolTask,
	watchEvents,
} from "@amazme/durable";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createBashTool } from "../src/tools/index.ts";
import { allEntries, type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";

const Count = Type.Object({ count: Type.Number() });

/** A tool that returns `result`, with `extra` such as a schema. */
function returning(name: string, result: ToolExecutionResult, extra: Partial<ToolRegistration> = {}): ToolRegistration {
	return defineTool({
		name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => result,
		...extra,
	});
}

function call(name: string): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, {}, { id: "c1" })], { stopReason: "toolUse" });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

/** Run `name` as a nested call of a `probe` tool and return what the probe received. */
async function nested(setup: ChatSetup, name: string): Promise<NestedToolExecutionResult> {
	let received: NestedToolExecutionResult | undefined;
	addTool(
		setup.registry,
		defineTool({
			name: "probe",
			description: "probe",
			parameters: Type.Object({}),
			execute: async (_args, api, callContext) => {
				received = await api.executeTool(name, {}, callContext);
				return {};
			},
		}),
	);
	setup.faux.setResponses([call("probe"), DONE]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	await harness.close(context);
	return received!;
}

/** Run `name` as a model-issued call and return its transcript message. */
async function direct(setup: ChatSetup, name: string): Promise<ToolResultMessage> {
	setup.faux.setResponses([call(name), DONE]);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
	await harness.close(context);
	return entry.model![0] as ToolResultMessage;
}

function codes(result: { readonly diagnostics?: readonly { readonly code?: string }[] }): (string | undefined)[] {
	return (result.diagnostics ?? []).map((diagnostic) => diagnostic.code);
}

describe("structured output", () => {
	it("gives callers a schema-less tool's output: one text as a string, one image as itself, else the list", async () => {
		const text = { type: "text" as const, text: "one" };
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const cases: [output: (typeof text | typeof image)[], value: JsonValue][] = [
			[[text], "one"],
			[[image], image],
			[[], ""],
			[
				[text, image],
				[text, image],
			],
			[
				[text, text],
				[text, text],
			],
		];
		for (const [output, value] of cases) {
			const setup = chatSetup();
			addTool(setup.registry, returning("plain", { output }));
			const received = await nested(setup, "plain");
			expect(received).toEqual({
				taskId: received.taskId,
				structuredOutput: value,
				isError: false,
				diagnostics: [],
				durationMs: received.durationMs,
			});
		}
	});

	it("gives callers the bounded output, as the model sees it, without the rendered diagnostics", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			returning(
				"long",
				{ output: [{ type: "text", text: "a\nb\nc" }], diagnostics: [{ severity: "info", message: "note" }] },
				{ outputLimits: { maxLines: 1 } },
			),
		);
		const received = await nested(setup, "long");
		expect(received.structuredOutput).toBe("a\n");
		expect(codes(received)).toEqual([undefined, "truncated"]);
	});

	it("stores exactly what callers and events get, without the model's output, and keeps a stored null", async () => {
		const setup = chatSetup();
		addTool(setup.registry, returning("plain", { output: [{ type: "text", text: "a" }] }));
		addTool(
			setup.registry,
			returning("nothing", { structuredOutput: null }, { structuredOutputSchema: Type.Null() }),
		);
		const received: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			defineTool({
				name: "probe",
				description: "probe",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					received.push(await api.executeTool("plain", {}, callContext));
					received.push(await api.executeTool("nothing", {}, callContext));
					return {};
				},
			}),
		);
		setup.faux.setResponses([call("probe"), DONE]);
		const storage = new MemoryStorage();
		const { harness, root } = await openChat(storage, setup);
		// The result each nested call's document got, as committed.
		const stored: JsonValue[] = [];
		harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type !== "document" || change.record.kind !== NestedCallDoc.definition.kind) continue;
				const result = (change.value as NestedCallState | null)?.result;
				if (result !== undefined && change.ops.length > 0) stored.push(result as unknown as JsonValue);
			}
		});
		const stream = await watchEvents(harness, root.id, context);
		const ends: NestedToolExecutionResult[] = [];
		stream.start(async (batch) => {
			for (const event of batch) {
				if (event.type === "tool_execution_end" && event.parentToolCallId !== undefined) {
					ends.push(event.result as NestedToolExecutionResult);
				}
			}
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await harness.waitForIdle(context);
		await stream.stop();
		await harness.close(context);

		expect(received[0]).toMatchObject({ structuredOutput: "a", isError: false });
		expect(received[1]).toMatchObject({ structuredOutput: null, isError: false });
		expect(received[0]).not.toHaveProperty("output");
		expect(stored).toEqual(received);
		expect(ends).toEqual(received);
	});

	it("gives callers a schema tool's validated structured output, which the transcript does not store", async () => {
		const setup = chatSetup();
		const result = { output: [{ type: "text" as const, text: "3 things" }], structuredOutput: { count: 3 } };
		addTool(setup.registry, returning("counter", result, { structuredOutputSchema: Count }));
		expect(await nested(setup, "counter")).toMatchObject({ structuredOutput: { count: 3 }, isError: false });

		const modelSetup = chatSetup();
		addTool(modelSetup.registry, returning("counter", result, { structuredOutputSchema: Count }));
		const stored = await direct(modelSetup, "counter");
		expect(stored).toMatchObject({ isError: false, content: [{ type: "text", text: "3 things" }] });
		expect(stored).not.toHaveProperty("structuredOutput");
	});

	it("turns structured output that breaks the schema into an error result for callers, and a report for the model's calls", async () => {
		const cases: [name: string, result: ToolExecutionResult, schema: boolean, message: string][] = [
			["wrong", { structuredOutput: { count: "three" } }, true, "does not match its schema: count:"],
			["missing", { output: [] }, true, "returned no structuredOutput"],
			["undeclared", { structuredOutput: { count: 3 } }, false, "declares no structuredOutputSchema"],
		];
		for (const [name, result, schema, message] of cases) {
			const setup = chatSetup();
			addTool(setup.registry, returning(name, result, schema ? { structuredOutputSchema: Count } : {}));
			const received = await nested(setup, name);
			expect(received.isError).toBe(true);
			// The broken value is dropped; a schema-less tool's error result still carries its output, here none.
			if (schema) expect(received).not.toHaveProperty("structuredOutput");
			else expect(received.structuredOutput).toBe("");
			expect(codes(received)).toEqual(["invalid_structured_output"]);
			expect(received.diagnostics[0]?.message).toContain(message);

			const modelSetup = chatSetup();
			addTool(modelSetup.registry, returning(name, result, schema ? { structuredOutputSchema: Count } : {}));
			// The model never sees structured output: its call stands, and the host gets a report.
			const stored = await direct(modelSetup, name);
			expect(stored.isError).toBe(false);
			expect(JSON.stringify(stored.content)).not.toContain(message);
			expect(modelSetup.reports.map((error) => (error as Error).message).join("\n")).toContain(message);
		}
	});

	it("gives callers the output of an error result of a tool without a schema", async () => {
		const setup = chatSetup();
		addTool(setup.registry, returning("bad", { output: [{ type: "text", text: "bad" }], isError: true }));
		expect(await nested(setup, "bad")).toMatchObject({ isError: true, structuredOutput: "bad" });
	});

	it("gives callers no structured output for an error result the Harness wrote, only diagnostics", async () => {
		const setup = chatSetup();
		const received = await nested(setup, "missing");
		expect(received).toMatchObject({ isError: true, diagnostics: [{ code: "tool_unavailable" }] });
		expect(received).not.toHaveProperty("structuredOutput");
	});

	it("gives callers a schema tool's error text as a diagnostic, never as structured output", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			returning(
				"fails",
				{ output: [{ type: "text", text: "nope" }], isError: true },
				{ structuredOutputSchema: Count },
			),
		);
		// Its text reaches the caller as an error diagnostic: structuredOutput is only ever the tool's own value.
		const received = await nested(setup, "fails");
		expect(received).toMatchObject({
			isError: true,
			diagnostics: [{ severity: "error", code: "tool_error", message: "nope" }],
		});
		expect(received).not.toHaveProperty("structuredOutput");

		// The model's call keeps the text in its output, without the extra diagnostic.
		const modelSetup = chatSetup();
		addTool(
			modelSetup.registry,
			returning(
				"fails",
				{ output: [{ type: "text", text: "nope" }], isError: true },
				{ structuredOutputSchema: Count },
			),
		);
		const stored = await direct(modelSetup, "fails");
		expect(stored.content).toEqual([{ type: "text", text: "nope" }]);

		// A thrown error's message is in its tool_error diagnostic, not in the output.
		const thrown = chatSetup();
		addTool(
			thrown.registry,
			defineTool({
				name: "throws",
				description: "throws",
				parameters: Type.Object({}),
				structuredOutputSchema: Count,
				execute: async () => {
					throw new Error("permission denied");
				},
			}),
		);
		const thrownResult = await nested(thrown, "throws");
		// One diagnostic: the thrown message, not a second one from its (empty) output.
		expect(thrownResult).toMatchObject({
			isError: true,
			diagnostics: [{ code: "tool_error", message: "permission denied" }],
		});
		expect(thrownResult.diagnostics).toHaveLength(1);
		expect(thrownResult).not.toHaveProperty("structuredOutput");

		// An error result whose own diagnostics say what went wrong gets no second one from its output.
		const explained = chatSetup();
		addTool(
			explained.registry,
			returning(
				"fails",
				{
					output: [{ type: "text", text: "partial log" }],
					isError: true,
					diagnostics: [{ severity: "error", code: "quota", message: "quota exceeded" }],
				},
				{ structuredOutputSchema: Count },
			),
		);
		expect((await nested(explained, "fails")).diagnostics).toEqual([
			{ severity: "error", code: "quota", message: "quota exceeded" },
		]);

		// An error result that has structured output keeps it.
		const kept = chatSetup();
		const withValue = {
			output: [{ type: "text" as const, text: "nope" }],
			structuredOutput: { count: 0 },
			isError: true,
		};
		addTool(kept.registry, returning("fails", withValue, { structuredOutputSchema: Count }));
		expect(await nested(kept, "fails")).toMatchObject({ isError: true, structuredOutput: { count: 0 } });
	});

	it("drops stale structured output when afterTool replaces the output, and validates an explicit replacement", async () => {
		const setup = chatSetup();
		addTool(setup.registry, returning("plain", { output: [{ type: "text", text: "secret" }] }));
		addTool(
			setup.registry,
			returning("counter", { structuredOutput: { count: 1 } }, { structuredOutputSchema: Count }),
		);
		addTool(
			setup.registry,
			returning("other", { structuredOutput: { count: 1 } }, { structuredOutputSchema: Count }),
		);
		addHooks(setup.registry, ToolTask, {
			afterTool: (hookCall, result) =>
				hookCall.name === "other"
					? { ...result, structuredOutput: { count: "broken" } as unknown as JsonValue }
					: hookCall.name === "probe"
						? result
						: { ...result, output: [{ type: "text", text: "rewritten" }] },
		});
		let plain: NestedToolExecutionResult | undefined;
		let counter: NestedToolExecutionResult | undefined;
		let other: NestedToolExecutionResult | undefined;
		addTool(
			setup.registry,
			defineTool({
				name: "probe",
				description: "probe",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					plain = await api.executeTool("plain", {}, callContext);
					counter = await api.executeTool("counter", {}, callContext);
					other = await api.executeTool("other", {}, callContext);
					return {};
				},
			}),
		);
		setup.faux.setResponses([call("probe"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await harness.close(context);
		// A schema-less tool's value is its output, so redacting the output redacts what programs get.
		expect(plain?.structuredOutput).toBe("rewritten");
		expect(counter).not.toHaveProperty("structuredOutput");
		expect(counter?.isError).toBe(true);
		expect(codes(counter!)).toEqual(["invalid_structured_output"]);
		expect(other?.isError).toBe(true);
		expect(codes(other!)).toEqual(["invalid_structured_output"]);
	});

	it("drops an unchanged primitive when afterTool rewrites the output", async () => {
		const cases: readonly [string, JsonValue][] = [
			["count", 7],
			["label", "secret-label"],
			["flag", false],
			["empty", null],
		];
		const schemaFor = (value: JsonValue) =>
			typeof value === "number" ? Type.Number()
			: typeof value === "string" ? Type.String()
			: typeof value === "boolean" ? Type.Boolean()
			: Type.Null();
		const setup = chatSetup();
		for (const [name, value] of cases) {
			addTool(
				setup.registry,
				returning(
					name,
					{ output: [{ type: "text", text: "secret" }], structuredOutput: value },
					{ structuredOutputSchema: schemaFor(value) },
				),
			);
		}
		addHooks(setup.registry, ToolTask, {
			afterTool: (hookCall, result) =>
				hookCall.name === "probe" ? result : { ...result, output: [{ type: "text", text: "[redacted]" }] },
		});
		const received = new Map<string, NestedToolExecutionResult>();
		addTool(
			setup.registry,
			defineTool({
				name: "probe",
				description: "probe",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					for (const [name] of cases) received.set(name, await api.executeTool(name, {}, callContext));
					return {};
				},
			}),
		);
		setup.faux.setResponses([call("probe"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await harness.close(context);
		for (const [name] of cases) {
			const result = received.get(name);
			expect(result?.isError).toBe(true);
			expect(result).not.toHaveProperty("structuredOutput");
		}
		expect(JSON.stringify(received.get("label"))).not.toContain("secret-label");

		const modelSetup = chatSetup();
		addTool(
			modelSetup.registry,
			returning(
				"count",
				{ output: [{ type: "text", text: "secret" }], structuredOutput: 7 },
				{ structuredOutputSchema: Type.Number() },
			),
		);
		addHooks(modelSetup.registry, ToolTask, {
			afterTool: (_call, result) => ({ ...result, output: [{ type: "text", text: "[redacted]" }] }),
		});
		const stored = await direct(modelSetup, "count");
		expect(stored.isError).toBe(false);
		expect(modelSetup.reports.map((error) => (error as Error).message)).toEqual([
			"Tool count returned no structuredOutput",
		]);
	});

	it("keeps a primitive when afterTool retains the structured value", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			returning(
				"count",
				{ output: [{ type: "text", text: "secret" }], structuredOutput: 7 },
				{ structuredOutputSchema: Type.Number() },
			),
		);
		addHooks(setup.registry, ToolTask, {
			afterTool: (hookCall, result) =>
				hookCall.name === "probe"
					? result
					: retainStructuredOutput({ ...result, output: [{ type: "text", text: "rewritten" }] }),
		});
		const received = await nested(setup, "count");
		expect(received).toMatchObject({ isError: false, structuredOutput: 7 });

		const modelSetup = chatSetup();
		addTool(
			modelSetup.registry,
			returning(
				"count",
				{ output: [{ type: "text", text: "secret" }], structuredOutput: 7 },
				{ structuredOutputSchema: Type.Number() },
			),
		);
		addHooks(modelSetup.registry, ToolTask, {
			afterTool: (_call, result) =>
				retainStructuredOutput({ ...result, output: [{ type: "text", text: "rewritten" }] }),
		});
		const stored = await direct(modelSetup, "count");
		expect(stored.isError).toBe(false);
		expect(modelSetup.reports).toEqual([]);
	});

	it("drops an explicitly retained value when a later hook rewrites the output without retaining it", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			returning(
				"secret",
				{ output: [{ type: "text", text: "secret-label" }], structuredOutput: "secret-label" },
				{ structuredOutputSchema: Type.String() },
			),
		);
		addHooks(setup.registry, ToolTask, {
			afterTool: (hookCall, result) => hookCall.name === "secret"
				? retainStructuredOutput({ ...result, output: [{ type: "text", text: "converted" }] })
				: undefined,
		});
		addHooks(setup.registry, ToolTask, {
			afterTool: (hookCall, result) => hookCall.name === "secret"
				? { ...result, output: [{ type: "text", text: "[redacted]" }] }
				: undefined,
		});
		const received = await nested(setup, "secret");
		expect(received.isError).toBe(true);
		expect(received).not.toHaveProperty("structuredOutput");
		expect(JSON.stringify(received)).not.toContain("secret-label");
	});

	it("gives callers of bash its retained output and exit code, also for a nonzero exit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-durable-structured-"));
		try {
			const setup = chatSetup();
			addTool(setup.registry, createBashTool());
			const received: NestedToolExecutionResult[] = [];
			addTool(
				setup.registry,
				defineTool({
					name: "probe",
					description: "probe",
					parameters: Type.Object({}),
					execute: async (_args, api, callContext) => {
						received.push(await api.executeTool("bash", { command: "printf ok" }, callContext));
						received.push(await api.executeTool("bash", { command: "printf bad; exit 4" }, callContext));
						return {};
					},
				}),
			);
			setup.faux.setResponses([call("probe"), DONE]);
			const env = new NodeExecutionEnv({ artifactDirectory: directory, cwd: directory });
			const { harness, root } = await openChat(new MemoryStorage(), setup, { env });
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			await harness.close(context);
			expect(received[0]).toMatchObject({
				isError: false,
				structuredOutput: { output: "ok", truncated: false, exitCode: 0 },
			});
			expect(received[1]).toMatchObject({
				isError: true,
				structuredOutput: { output: "bad", truncated: false, exitCode: 4 },
			});
			expect(codes(received[1]!)).toEqual(["exit_code"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
