import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentOf, openDurable } from "../src/durable/runtime.ts";
import { runDurableTui } from "../src/durable/tui.ts";
import { main } from "../src/main.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

// Only the terminal presentation is replaced; main, model resolution, settings and SQLite run normally.
vi.mock("../src/durable/tui.ts", () => ({ runDurableTui: vi.fn() }));

describe("main's default durable TUI startup", () => {
	let directory: string | undefined;
	const ttyDescriptors = [process.stdin, process.stdout].map((stream) =>
		Object.getOwnPropertyDescriptor(stream, "isTTY"),
	);

	afterEach(async () => {
		[process.stdin, process.stdout].forEach((stream, index) => {
			const descriptor = ttyDescriptors[index];
			if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
			else Object.defineProperty(stream, "isTTY", descriptor);
		});
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	});

	it("passes model, thinking, credential and theme to the actual SQLite runtime", async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-main-durable-"));
		const cwd = join(directory, "project");
		const profile = join(directory, "profile");
		await mkdir(cwd);
		await mkdir(profile);
		await writeFile(
			join(profile, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						models: [
							{
								id: "reason",
								name: "Fixture",
								reasoning: true,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 8192,
							},
						],
					},
				},
			}),
		);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		vi.stubEnv("AMAZME_STARTUP_BENCHMARK", "0");
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		for (const stream of [process.stdin, process.stdout])
			Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		let sessionDirectory = "";
		vi.mocked(runDurableTui).mockImplementation(async (view, _controller, settings) => {
			expect(agentOf(view.current().conversation)).toMatchObject({
				model: { provider: "fixture", modelId: "reason" },
				thinkingLevel: "low",
			});
			expect(settings.getTheme()).toBe("light");
			expect(agentOf(view.current().conversation).tools).toEqual({ allow: ["grep"] });
			const storedDirectory = view.current().session.directory;
			expect(storedDirectory).toBeDefined();
			if (storedDirectory === undefined) throw new Error("Expected a persistent session directory");
			sessionDirectory = storedDirectory;
		});
		await main([
			"--offline",
			"--provider",
			"fixture",
			"--model",
			"reason:high",
			"--thinking",
			"low",
			"--api-key",
			"fixture-secret",
			"--use-theme",
			"light",
			"--no-tools",
			"--tools",
			"+grep,-write",
		]);
		expect(runDurableTui).toHaveBeenCalledOnce();
		expect(JSON.parse(await readFile(join(profile, "auth.json"), "utf8"))).toEqual({});
		expect((await readFile(join(sessionDirectory, "session.sqlite"))).includes(Buffer.from("fixture-secret"))).toBe(
			false,
		);
		// The entry point's finally closes storage and releases its lock; a fresh open can immediately resume.
		const restored = await openDurable({ cwd, continueSession: true });
		try {
			expect(restored.view.current().session.directory).toBe(sessionDirectory);
			expect(agentOf(restored.view.current().conversation).thinkingLevel).toBe("low");
			expect(restored.settings.getTheme()).not.toBe("light");
		} finally {
			await restored.close();
		}
	});

	async function rejectInteractive(args: readonly string[]): Promise<{ errors: string; profile: string }> {
		directory = await mkdtemp(join(tmpdir(), "amazme-main-durable-"));
		const cwd = join(directory, "project");
		const profile = join(directory, "profile");
		await mkdir(cwd);
		await mkdir(profile);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		vi.stubEnv("AMAZME_STARTUP_BENCHMARK", "0");
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		for (const stream of [process.stdin, process.stdout]) {
			Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		}
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
			errors.push(typeof message === "string" ? message : String(message));
		});
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});
		vi.mocked(runDurableTui).mockClear();
		await expect(main(["--offline", ...args])).rejects.toThrow("exit:1");
		return { errors: stripAnsi(errors.join("\n")), profile };
	}

	it.each([
		["--fork", "source.jsonl"],
		["--session", "session.jsonl"],
		["--session-id", "sess1"],
	])("interactive %s exits 1 and does not create a durable store", async (flag, value) => {
		const { errors, profile } = await rejectInteractive([flag, value]);
		expect(errors).toContain(
			"Error: the interactive TUI stores conversations in the durable session. Use /tree and /fork inside it. --fork, --session, and --session-id select the JSONL session, which print and RPC still use.",
		);
		expect(runDurableTui).not.toHaveBeenCalled();
		expect(existsSync(join(profile, "experimental", "durable-sessions"))).toBe(false);
	});

	it.each(["--continue", "--resume"])(
		"interactive --no-session with %s exits 1 and does not create a durable store",
		async (flag) => {
			const { errors, profile } = await rejectInteractive(["--no-session", flag]);
			expect(errors).toContain("Error: --no-session cannot be combined with --continue or --resume");
			expect(runDurableTui).not.toHaveBeenCalled();
			expect(existsSync(join(profile, "experimental", "durable-sessions"))).toBe(false);
		},
	);
});
