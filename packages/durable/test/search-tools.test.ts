import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, JsonValue } from "@amazme/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionError, err, ok } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { ToolResultEntry } from "../src/entries.ts";
import type { ToolDiagnostic, ToolExecutionApi, ToolRegistration } from "../src/harness/types.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { createFindTool, createGrepTool, createLsTool, FileSearchTools } from "../src/tools/index.ts";
import { DEFAULT_MAX_BYTES } from "../src/truncate.ts";
import { allEntries, chatSetup, openChat, textOf } from "./chat-support.ts";

describe("portable search tools", () => {
	let directory: string;
	let env: NodeExecutionEnv;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-search-tools-"));
		env = new NodeExecutionEnv({ cwd: directory });
		await mkdir(join(directory, "src"));
		await writeFile(join(directory, "src", "a.test.ts"), "before\nAlpha a.b\naXb\nafter\n");
		await writeFile(join(directory, ".hidden.ts"), "Alpha\n");
		await writeFile(join(directory, "b.md"), "alpha\n");
		await writeFile(join(directory, ".gitignore"), "skip*\n");
		await writeFile(join(directory, "skip.ts"), "Alpha\n");
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await env.cleanup(BACKGROUND_CONTEXT);
		await rm(directory, { recursive: true, force: true });
	});

	async function run(tool: ToolRegistration, args: JsonValue, context: Context = BACKGROUND_CONTEXT) {
		const output: string[] = [];
		const diagnostics: ToolDiagnostic[] = [];
		const api = {
			env,
			output: (text: string | Uint8Array) =>
				output.push(typeof text === "string" ? text : new TextDecoder().decode(text)),
			diagnostic: (item: ToolDiagnostic) => diagnostics.push(item),
		} as unknown as ToolExecutionApi;
		const result = await tool.execute(args, api, context);
		return { ...result, output: output.join(""), diagnostics };
	}

	it("executes model-requested search calls and restores their actual results from SQLite", async () => {
		const setup = chatSetup();
		setup.registry.install(FileSearchTools);
		setup.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("grep", { pattern: "Alpha", path: "src" }),
					fauxToolCall("find", { pattern: "src/**/*.test.ts" }),
					fauxToolCall("ls", { path: "src" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("search completed"),
		]);
		const database = join(directory, "search.sqlite");
		const opened = await openChat(await openNodeSqliteStorage(database), setup, { env });
		let before: Awaited<ReturnType<typeof allEntries>> = [];
		try {
			const settled = await (
				await opened.root.submit({ type: "input", content: "search project" }, BACKGROUND_CONTEXT)
			).wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");
			before = (await allEntries(opened.root)).filter(ToolResultEntry.is);
			expect(before).toHaveLength(3);
			const messages = before.map((entry) => entry.model?.[0]);
			expect(messages.map(textOf).join("\n")).toContain("a.test.ts:2:Alpha a.b");
			expect(messages.map(textOf).join("\n")).toContain("src/a.test.ts");
			for (const message of messages)
				expect(message).toMatchObject({ role: "toolResult", isError: false, details: { truncated: false } });
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
		const restored = await openChat(await openNodeSqliteStorage(database), setup, { env });
		try {
			expect((await allEntries(restored.root)).filter(ToolResultEntry.is)).toEqual(before);
			expect(setup.faux.state.callCount).toBe(2);
		} finally {
			await restored.harness.close(BACKGROUND_CONTEXT);
		}
	});

	it("grep searches hidden files, filters globs and supports literals and case folding", async () => {
		const literal = await run(createGrepTool(), { pattern: "a.b", literal: true, glob: "*.ts" });
		expect(literal.output).toContain("a.test.ts:2:Alpha a.b");
		expect(literal.output).not.toContain("aXb");
		const regex = await run(createGrepTool(), { pattern: "a.b", path: "src" });
		expect(regex.output).toContain("a.test.ts:3:aXb");
		const insensitive = await run(createGrepTool(), { pattern: "alpha", ignoreCase: true, glob: "*.ts" });
		expect(insensitive.output).toContain(".hidden.ts:1:Alpha");
		expect(insensitive.output).not.toContain("b.md:");
	});

	it("grep includes context within its declared output-line budget", async () => {
		const result = await run(createGrepTool(), { pattern: "Alpha", path: "src/a.test.ts", context: 1, limit: 2 });
		expect(result.output.trimEnd().split("\n")).toHaveLength(2);
		expect(result.output).toContain("before");
		expect(result.output).toContain("Alpha");
		expect(result.details).toEqual({ truncated: true });
		expect(result.diagnostics[0]?.code).toBe("result_limit");
	});

	it.each([createGrepTool(), createFindTool()])(
		"%s reports no matches without treating it as an error",
		async (tool) => {
			const result = await run(tool, { pattern: "never-found" });
			expect(result.output).toBe("No results found");
			expect(result.details).toEqual({ truncated: false });
		},
	);

	it.each([createGrepTool(), createFindTool()])(
		"%s rejects malformed patterns instead of reporting no matches",
		async (tool) => {
			await expect(run(tool, { pattern: "[" })).rejects.toThrow();
		},
	);

	it("find matches root-relative path globs, respects ignores outside git and excludes dependency directories", async () => {
		await mkdir(join(directory, "node_modules"));
		await writeFile(join(directory, "node_modules", "other.test.ts"), "Alpha");
		const nested = await run(createFindTool(), { pattern: "src/**/*.test.ts" });
		expect(nested.output).toContain("src/a.test.ts");
		const all = await run(createFindTool(), { pattern: "*.ts" });
		expect(all.output).toContain(".hidden.ts");
		expect(all.output).not.toContain("skip.ts");
		expect(all.output).not.toContain("node_modules");
	});

	it("find accepts a symbolic directory path and bounds result paths", async () => {
		await symlink(join(directory, "src"), join(directory, "alias"), process.platform === "win32" ? "junction" : "dir");
		const alias = await run(createFindTool(), { pattern: "*.ts", path: "alias" });
		expect(alias.output).toContain("a.test.ts");
		const bounded = await run(createFindTool(), { pattern: "*", limit: 1 });
		expect(bounded.output.trimEnd().split("\n")).toHaveLength(1);
		expect(bounded.details).toEqual({ truncated: true });
	});

	it("find stops parent ignore rules at a nested repository", async () => {
		await mkdir(join(directory, ".git"));
		await mkdir(join(directory, "nested"));
		await mkdir(join(directory, "nested", ".git"));
		await writeFile(join(directory, ".gitignore"), "*.txt\n");
		await writeFile(join(directory, "nested", "kept.txt"), "nested repository");
		const result = await run(createFindTool(), { pattern: "*.txt", path: "nested" });
		expect(result.output).toContain("kept.txt");
	});

	it("cancels a pending program resolver before any process starts", async () => {
		const abort = new AbortController();
		const spawn = vi.spyOn(env, "exec");
		let started = (): void => {};
		const resolving = new Promise<void>((resolve) => {
			started = resolve;
		});
		const tool = createGrepTool({
			program: async () => {
				started();
				return new Promise(() => {});
			},
		});
		const pending = run(tool, { pattern: "Alpha" }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
		await resolving;
		abort.abort(new Error("fixture cancellation"));
		await expect(pending).rejects.toThrow("fixture cancellation");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("propagates cancellation of an active search without aborting its environment", async () => {
		let started = (): void => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		vi.spyOn(env, "exec").mockImplementationOnce(async (_command, _options, context) => {
			started();
			return new Promise((resolve) =>
				context.abortSignal?.addEventListener(
					"abort",
					() => {
						resolve(err(new ExecutionError("aborted", "search aborted")));
					},
					{ once: true },
				),
			);
		});
		const cleanup = vi.spyOn(env, "cleanup");
		const abort = new AbortController();
		const pending = run(createGrepTool(), { pattern: "Alpha" }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
		await running;
		abort.abort(new Error("fixture cancellation"));
		await expect(pending).rejects.toThrow("fixture cancellation");
		expect(cleanup).not.toHaveBeenCalled();
		expect((await env.exec([process.execPath, "-e", ""], undefined, BACKGROUND_CONTEXT)).ok).toBe(true);
	});

	it("grep passes flags, metacharacters and space-containing paths as literal argv", async () => {
		const path = "space ; dollar $(false).txt";
		await writeFile(join(directory, path), "--flag $(false)\n");
		const result = await run(createGrepTool(), { pattern: "--flag $(false)", path, literal: true });
		expect(result.output).toContain("--flag $(false)");
	});

	it("listing includes hidden entries and directory suffixes in alphabetical order", async () => {
		const result = await run(createLsTool(), {});
		expect(result.content).toEqual([{ type: "text", text: ".gitignore\n.hidden.ts\nb.md\nskip.ts\nsrc/" }]);
		expect(result.details).toEqual({ truncated: false });
	});

	it("listing keeps the globally earliest names across directory pages", async () => {
		let pages = 0;
		const close = vi.fn(async () => {});
		vi.spyOn(env, "openDirReader").mockResolvedValue(
			ok({
				close,
				next: async () => {
					pages++;
					return ok({
						done: pages === 2,
						entries: (pages === 1 ? ["z", "y", "x"] : ["b", "a"]).map((name) => ({
							name,
							path: name,
							kind: "file" as const,
							size: 0,
							mtimeMs: 0,
						})),
					});
				},
			}),
		);
		const result = await run(createLsTool(), { limit: 2 });
		expect(result.content).toEqual([{ type: "text", text: "a\nb" }]);
		expect(result.details).toEqual({ truncated: true });
		expect(close).toHaveBeenCalledOnce();
	});

	it("listing closes its reader with an uncancelled cleanup context", async () => {
		const abort = new AbortController();
		const close = vi.fn(async (context: Context) => expect(context.abortSignal).toBeUndefined());
		vi.spyOn(env, "openDirReader").mockResolvedValue(
			ok({
				close,
				next: async () => {
					abort.abort(new Error("fixture cancellation"));
					throw abort.signal.reason;
				},
			}),
		);
		await expect(run(createLsTool(), {}, withAbortSignal(abort.signal, BACKGROUND_CONTEXT))).rejects.toThrow(
			"fixture cancellation",
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("search limit kills only that search and leaves sibling commands running", async () => {
		const otherOutput: string[] = [];
		const other = env.exec(
			[process.execPath, "-e", "setTimeout(() => console.log('other completed'), 100)"],
			{
				onOutput: (text) => otherOutput.push(text),
			},
			BACKGROUND_CONTEXT,
		);
		const result = await run(createGrepTool(), { pattern: "Alpha", limit: 1 });
		expect(result.details).toEqual({ truncated: true });
		expect((await other).ok).toBe(true);
		expect(otherOutput.join("")).toContain("other completed");
	});

	it("bounds a large Unicode chunk without splitting characters or retaining the raw stream", async () => {
		vi.spyOn(env, "exec").mockImplementationOnce(async (_command, options, context) => {
			options?.onOutput?.("漢😀".repeat(DEFAULT_MAX_BYTES), context, { stream: "stdout" });
			expect(context.abortSignal?.aborted).toBe(true);
			return err(new ExecutionError("aborted", "search stopped"));
		});
		const result = await run(createGrepTool(), { pattern: "." });
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.output).not.toContain("\ufffd");
		expect(result.details).toEqual({ truncated: true });
	});

	it.each([createGrepTool(), createFindTool(), createLsTool()])(
		"%s rejects an invalid limit before filesystem or process work",
		async (tool) => {
			const spawn = vi.spyOn(env, "exec");
			const open = vi.spyOn(env, "openDirReader");
			await expect(run(tool, { pattern: "*", limit: -1 })).rejects.toThrow("limit must be an integer");
			expect(spawn).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		},
	);

	it.each([createGrepTool(), createFindTool(), createLsTool()])("%s propagates caller cancellation", async (tool) => {
		const abort = new AbortController();
		abort.abort(new Error("fixture cancellation"));
		await expect(run(tool, { pattern: "*" }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT))).rejects.toThrow();
	});
});
