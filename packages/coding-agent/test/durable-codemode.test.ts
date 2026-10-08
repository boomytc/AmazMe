import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@amazme/ai";
import { AgentDoc, createRegistry, defineExtension, defineTool, Harness, MemoryStorage, NestedToolResultEntry, ToolResultEntry, ToolTask, hook } from "@amazme/durable";
import type { Conversation, Harness as HarnessType, Storage, ToolRegistration } from "@amazme/durable";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import { CodingTools } from "@amazme/durable/tools";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodemodeStoreDoc, createDurableCodemode } from "../src/durable/codemode.ts";
import { openDurable, type OpenDurableResult } from "../src/durable/runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const harnesses = new Set<HarnessType>();
const sessions = new Set<OpenDurableResult>();
const directories = new Set<string>();
const done = () => fauxAssistantMessage([fauxText("done")]);

async function directory() {
	const path = await mkdtemp(join(tmpdir(), "amazme-durable-codemode-"));
	directories.add(path);
	return path;
}

async function open(options: { cwd?: string; storage?: Storage; settings?: SettingsManager; tools?: ToolRegistration[] } = {}) {
	const cwd = options.cwd ?? await directory();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(createDurableCodemode(options.settings ?? SettingsManager.inMemory()));
	if (options.tools) registry.install(defineExtension({ name: "fixture", tools: options.tools }));
	const harness = await Harness.open(options.storage ?? new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd }) }, context);
	harnesses.add(harness);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd }, init: async (tx, id) => {
		(await tx.doc(AgentDoc, id)).tools = { add: ["codemode", "tool_search"] };
	} });
	return { root, harness, faux, registry, cwd };
}

async function run(opened: Awaited<ReturnType<typeof open>>, code: string, id = "script") {
	opened.faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code }, { id })], { stopReason: "toolUse" }), done()]);
	const settled = await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
	expect(settled.status).toBe("done");
	const entries = (await opened.root.entries({}, 1000, undefined, context)).items;
	const entry = entries.filter(ToolResultEntry.is).find((candidate) => candidate.model?.[0]?.role === "toolResult" && candidate.model[0].toolCallId === id)!;
	const message = entry.model![0];
	if (message?.role !== "toolResult") throw new Error("Missing script result");
	return { entries, entry, message, text: message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n") };
}

afterEach(async () => {
	for (const session of sessions) await session.close();
	sessions.clear();
	for (const harness of harnesses) await harness.close(context);
	harnesses.clear();
	vi.unstubAllEnvs();
	for (const path of directories) await rm(path, { recursive: true, force: true });
	directories.clear();
});

describe("Durable codemode", () => {
	it("runs actual read/edit tools through persistent children and projects only-mode declarations", async () => {
		const opened = await open({ settings: SettingsManager.inMemory({ codemode: { mode: "only" } }) });
		await writeFile(join(opened.cwd, "file.txt"), "before\n");
		const agent = await opened.root.agent(context);
		expect(agent.tools.map((tool) => tool.name)).toEqual(["codemode", "tool_search"]);
		expect(agent.callableTools.map((tool) => tool.name)).toContain("read");
		expect(agent.tools.find((tool) => tool.name === "codemode")?.description).toContain("### `read`");
		const result = await run(opened, 'text(await tools.read({path:"file.txt"})); text(await tools.edit({path:"file.txt",edits:[{oldText:"before",newText:"after"}]}));');
		expect(result.message.isError).toBe(false);
		expect(result.text).toContain("before");
		expect(await readFile(join(opened.cwd, "file.txt"), "utf8")).toBe("after\n");
		expect(result.entries.filter(NestedToolResultEntry.is).map((entry) => entry.data.call.name).sort()).toEqual(["edit", "read"]);
		expect(result.entries.filter(NestedToolResultEntry.is).every((entry) => entry.model === undefined)).toBe(true);
		expect(result.entry.model?.[0]).toMatchObject({ details: { calls: [{ id: "script/1", status: "ok" }, { id: "script/2", status: "ok" }] } });
	});

	it("keeps only permitted tools in script discovery and applies blocking hooks to nested calls", async () => {
		let executed = 0;
		const opened = await open({ tools: [defineTool({ name: "secret", description: "Secret lookup", exposure: "deferred", parameters: Type.Object({}), execute: async () => { executed++; return { content: [] }; } })] });
		await opened.root.commit(async (tx) => { (await tx.doc(AgentDoc, opened.root.id)).tools = { allow: ["codemode", "read"], exclude: ["secret"] }; }, context);
		opened.registry.install(defineExtension({ name: "policy", hooks: [hook(ToolTask, { beforeTool: (call) => call.name === "read" ? { block: "fixture denied" } : undefined })] }));
		const result = await run(opened, 'text(ALL_TOOLS.map(t=>t.name)); try { await tools.read({path:"file.txt"}); } catch(e) { text(e.message); }');
		expect(result.text).toContain("fixture denied");
		expect(result.text).not.toContain("secret");
		expect(executed).toBe(0);
		expect(result.entries.find(NestedToolResultEntry.is)?.data.result.diagnostics).toContainEqual(expect.objectContaining({ code: "blocked" }));
	});

	it("returns full structured data to scripts and applies result redaction before the sandbox sees it", async () => {
		const opened = await open({ tools: [defineTool({ name: "record", description: "Record", exposure: "codemode", parameters: Type.Object({}), outputSchema: Type.Object({ value: Type.Number() }), execute: async () => ({ content: [{ type: "text", text: "record" }], structuredContent: { value: 42 } }) })] });
		expect((await run(opened, 'text((await tools.record({})).value);', "structured")).text).toContain("42");
		opened.registry.install(defineExtension({ name: "redact", hooks: [hook(ToolTask, { afterTool: (call, result) => call.name === "record" ? { ...result, content: [{ type: "text", text: "redacted" }] } : undefined })] }));
		const result = await run(opened, 'text(await tools.record({}));', "redaction");
		expect(result.text).toContain("redacted");
		expect(result.text).not.toContain("42");
	});

	it("persists successful store changes, drops failed writes and isolates forks", async () => {
		const opened = await open();
		await run(opened, 'store("answer",42); text("saved");', "saved");
		const at = (await opened.root.entries({}, 100, undefined, context)).items[0]!.id;
		const fork = await opened.root.fork(at, { ownership: { kind: "ownerless" } }, context);
		expect(await opened.harness.snapshot(CodemodeStoreDoc, fork.id, context)).toEqual({ values: { answer: 42 } });
		expect((await run(opened, 'store("answer",0); throw new Error("failed");', "failed")).message.isError).toBe(true);
		expect((await run(opened, 'text(load("answer")); store("answer",43);', "updated")).text).toContain("42");
		expect(await opened.harness.snapshot(CodemodeStoreDoc, opened.root.id, context)).toEqual({ values: { answer: 43 } });
		expect(await opened.harness.snapshot(CodemodeStoreDoc, fork.id, context)).toEqual({ values: { answer: 42 } });
	});

	it("restores script state from SQLite and keeps deletion and prototype-named keys safe", async () => {
		const cwd = await directory();
		const path = join(cwd, "session.sqlite");
		const first = await open({ cwd, storage: await openNodeSqliteStorage(path) });
		await run(first, 'store("__proto__",{value:42}); store("remove",true);', "seed");
		await first.harness.close(context);
		harnesses.delete(first.harness);
		const reopened = await open({ cwd, storage: await openNodeSqliteStorage(path) });
		const result = await run(reopened, 'text(load("__proto__")); store("remove",undefined);', "resume");
		expect(result.text).toContain('"value":42');
		const saved = await reopened.harness.snapshot(CodemodeStoreDoc, reopened.root.id, context);
		expect(Object.hasOwn(saved!.values, "__proto__")).toBe(true);
		expect(Object.hasOwn(saved!.values, "remove")).toBe(false);
	});

	it("loads deferred tool matches for the next request and retains activation on reopen", async () => {
		const cwd = await directory();
		const path = join(cwd, "session.sqlite");
		const tools = [defineTool({ name: "lookup", description: "Look up weather", exposure: "deferred", parameters: Type.Object({}), execute: async () => ({ content: [] }) })];
		const first = await open({ cwd, storage: await openNodeSqliteStorage(path), tools });
		first.faux.setResponses([fauxAssistantMessage([fauxToolCall("tool_search", { query: "weather" }, { id: "search" })], { stopReason: "toolUse" }), done()]);
		await (await first.root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect((await first.root.agent(context)).tools.map((tool) => tool.name)).toContain("lookup");
		await first.harness.close(context);
		harnesses.delete(first.harness);
		const reopened = await open({ cwd, storage: await openNodeSqliteStorage(path), tools });
		expect((await reopened.root.agent(context)).tools.map((tool) => tool.name)).toContain("lookup");
	});

	it("uses the actual default TUI controller and survives session reopening", async () => {
		const cwd = await directory();
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", join(cwd, "profile"));
		await writeFile(join(cwd, "file.txt"), "controller read\n");
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
		const faux = fauxProvider();
		runtime.registerNativeProvider({ ...faux.provider, auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key", source: "env" }), resolve: async () => ({ auth: {} }) } } });
		await runtime.refresh({ allowNetwork: false });
		const settings = SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "faux-1", retry: { enabled: false } });
		const first = await openDurable({ cwd, settingsManager: settings, modelRuntime: runtime, tools: ["codemode", "read"] });
		sessions.add(first);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(await tools.read({path:"file.txt"})); store("controller",42);' }, { id: "script" })], { stopReason: "toolUse" }), done()]);
		await first.controller.submit("go", "followUp");
		await vi.waitFor(() => { expect(faux.state.callCount).toBe(2); expect(first.view.current().conversation.docs["amazme.live"]?.run).toBeUndefined(); });
		expect(first.view.current().conversation.entries.some(NestedToolResultEntry.is)).toBe(true);
		await first.close();
		sessions.delete(first);
		const reopened = await openDurable({ cwd, settingsManager: settings, modelRuntime: runtime, continueSession: true });
		sessions.add(reopened);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(load("controller"));' }, { id: "restored" })], { stopReason: "toolUse" }), done()]);
		await reopened.controller.submit("resume", "followUp");
		await vi.waitFor(() => { expect(faux.state.callCount).toBe(4); expect(reopened.view.current().conversation.docs["amazme.live"]?.run).toBeUndefined(); });
		const result = reopened.view.current().conversation.entries.find((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolCallId === "restored");
		expect(JSON.stringify(result?.model)).toContain("42");
	});
});
