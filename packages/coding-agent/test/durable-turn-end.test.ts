import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runDurablePrint } from "../src/durable/print.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;

interface StreamLine {
	type: string;
	message?: { role?: string; content?: ReadonlyArray<{ type?: string; text?: string }> };
	toolResults?: unknown;
}

describe("durable turn_end stream", () => {
	let directory: string;
	let cwd: string;
	let profile: string;
	let runtime: ModelRuntime;
	let settings: SettingsManager;
	let faux: ReturnType<typeof fauxProvider>;
	const writes: string[] = [];
	const originalWrite = process.stdout.write;
	const children: ChildProcess[] = [];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-turn-end-"));
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		const credentials = AuthStorage.inMemory();
		runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		faux = fauxProvider({
			models: [{ id: "plain", reasoning: false, contextWindow: 200000, maxTokens: 8192 }],
		});
		runtime.registerNativeProvider({
			...faux.provider,
			auth: {
				apiKey: {
					name: "Fixture",
					check: async () => ({ type: "api_key", source: "env" }),
					resolve: async () => ({ auth: {} }),
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });
		settings = SettingsManager.inMemory({
			defaultProvider: "faux",
			defaultModel: "plain",
			retry: { enabled: false },
		});
		writes.length = 0;
		process.stdout.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			writes.push(String(chunk));
			(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.stdout.write = originalWrite;
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.length = 0;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("emits turn_end after the assistant message in json mode", async () => {
		faux.setResponses([fauxAssistantMessage("json answer")]);

		const exitCode = await runDurablePrint({
			mode: "json",
			cwd,
			modelRuntime: runtime,
			settingsManager: settings,
			noSession: true,
			noExtensions: true,
			noMcp: true,
			initialMessage: "say json answer",
		});

		expect(exitCode).toBe(0);
		const turnEnd = turnEndOf(parseLines(writes.join("")));
		expect(turnEnd.message).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "json answer" }],
		});
		expect(turnEnd.toolResults).toEqual([]);
	});

	it("emits turn_end after the assistant message in rpc mode", async () => {
		const script = join(directory, "rpc-child.mts");
		await writeFile(script, rpcChildSource(), "utf8");
		const stdout: string[] = [];
		const stderr: string[] = [];
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, script], {
			cwd: resolve(__dirname, "../../.."),
			env: {
				...process.env,
				AMAZME_CODING_AGENT_DIR: profile,
				AMAZME_TURN_END_CWD: cwd,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
		child.stdin?.write(`${JSON.stringify({ type: "prompt", message: "say rpc answer" })}\n`);

		const lines = await waitForTurn(stdout, stderr, child);
		const turnEnd = turnEndOf(lines);
		expect(turnEnd.message).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "rpc answer" }],
		});
		expect(turnEnd.toolResults).toEqual([]);
		child.stdin?.end();
		const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
		expect(signal).toBeNull();
		expect(code).toBe(0);
	});
});

function parseLines(text: string): StreamLine[] {
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as StreamLine);
}

function turnEndOf(lines: readonly StreamLine[]): StreamLine & { message: NonNullable<StreamLine["message"]>; toolResults: unknown } {
	const types = lines.map((line) => line.type);
	const turnEndAt = types.indexOf("turn_end");
	const assistantEnd = lines.findIndex((line) => line.type === "message_end" && line.message?.role === "assistant");
	expect(types.indexOf("turn_start")).toBeGreaterThanOrEqual(0);
	expect(assistantEnd).toBeGreaterThanOrEqual(0);
	expect(turnEndAt).toBeGreaterThan(types.indexOf("turn_start"));
	expect(turnEndAt).toBeGreaterThan(assistantEnd);
	expect(types.indexOf("agent_end")).toBeGreaterThan(turnEndAt);
	const turnEnd = lines[turnEndAt];
	if (turnEnd?.message === undefined || turnEnd.toolResults === undefined) {
		throw new Error(`turn_end missing message or toolResults: ${JSON.stringify(turnEnd)}`);
	}
	return { ...turnEnd, message: turnEnd.message, toolResults: turnEnd.toolResults };
}

async function waitForTurn(stdout: readonly string[], stderr: readonly string[], child: ChildProcess): Promise<StreamLine[]> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) break;
		const lines = parseLines(stdout.join(""));
		if (lines.some((line) => line.type === "turn_end") && lines.some((line) => line.type === "agent_end")) return lines;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`rpc stream did not emit turn_end\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`);
}

function rpcChildSource(): string {
	return `
import { fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import { AuthStorage } from "@amazme/coding-agent/core/auth-storage.ts";
import { ModelRuntime } from "@amazme/coding-agent/core/model-runtime.ts";
import { SettingsManager } from "@amazme/coding-agent/core/settings-manager.ts";
import { runDurableRpc } from "@amazme/coding-agent/modes/rpc/durable-rpc.ts";

const cwd = process.env.AMAZME_TURN_END_CWD;
if (!cwd) throw new Error("missing cwd");
const credentials = AuthStorage.inMemory();
const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
const faux = fauxProvider({
	models: [{ id: "plain", reasoning: false, contextWindow: 200000, maxTokens: 8192 }],
});
runtime.registerNativeProvider({
	...faux.provider,
	auth: {
		apiKey: {
			name: "Fixture",
			check: async () => ({ type: "api_key", source: "env" }),
			resolve: async () => ({ auth: {} }),
		},
	},
});
await runtime.refresh({ allowNetwork: false });
faux.setResponses([fauxAssistantMessage("rpc answer")]);
const settings = SettingsManager.inMemory({
	defaultProvider: "faux",
	defaultModel: "plain",
	retry: { enabled: false },
});
await runDurableRpc({
	cwd,
	modelRuntime: runtime,
	settingsManager: settings,
	noSession: true,
	noExtensions: true,
	noMcp: true,
});
`;
}
