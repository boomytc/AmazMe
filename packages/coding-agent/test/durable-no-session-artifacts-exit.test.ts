import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir } from "./temp-dir.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "support/legacy-durable-cli.ts");
const sessionsUrl = pathToFileURL(resolve(__dirname, "../src/durable/sessions.ts")).href;
const ARTIFACTS = "amazme-session-artifacts-";
const ptyHangup = resolve(__dirname, "fixtures/pty-hangup.py");
/** The interactive TUI needs a terminal; python3's `pty` module provides one where it exists. */
const hasPython = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

type Exit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * `--no-session` keeps its artifacts in a private temp directory. Each child gets its own TMPDIR, so
 * the test sees exactly what the process left behind: the artifact directory must exist while the
 * turn runs (a truncated bash result spilled into it) and be gone after every kind of exit.
 */
describe.skipIf(process.platform === "win32")("--no-session artifact directory on exit", () => {
	let directory: string;
	let temp: string;
	let profile: string;
	let server: Server;
	/** Whether the fixture answers the turn after the tool call, or holds it open for a signal. */
	let answer: boolean;
	/** The artifact directory's entries when the model got the tool result. */
	let duringTurn: Promise<string[]>;
	let markDuringTurn: (entries: string[]) => void;
	/** Permission bits of each artifact directory at that moment. */
	let modesDuringTurn: number[];
	const children: ChildProcess[] = [];

	const chunk = (delta: object, finish: string | null = null) =>
		`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

	const artifactEntries = (): string[] =>
		readdirSync(temp)
			.filter((name) => name.startsWith(ARTIFACTS))
			.flatMap((name) => readdirSync(join(temp, name)).map((entry) => `${name}/${entry}`));

	const artifactModes = (): number[] =>
		readdirSync(temp)
			.filter((name) => name.startsWith(ARTIFACTS))
			.map((name) => statSync(join(temp, name)).mode & 0o777);

	beforeEach(async () => {
		directory = createTempDir("amazme-no-session-exit-");
		temp = join(directory, "tmp");
		profile = join(directory, "profile");
		mkdirSync(temp);
		mkdirSync(profile);
		answer = true;
		modesDuringTurn = [];
		duringTurn = new Promise((resolveEntries) => {
			markDuringTurn = resolveEntries;
		});
		let requests = 0;
		server = createServer((request, response) => {
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			request.resume();
			request.on("end", () => {
				requests += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				if (requests === 1) {
					// Output past the bash tool's limits spills its full text into the artifact directory.
					response.write(
						chunk({
							role: "assistant",
							tool_calls: [
								{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "seq 1 100000" }) } },
							],
						}),
					);
					response.write(chunk({}, "tool_calls"));
					response.end("data: [DONE]\n\n");
					return;
				}
				modesDuringTurn = artifactModes();
				markDuringTurn(artifactEntries());
				if (!answer) return;
				response.write(chunk({ role: "assistant", content: "done" }));
				response.write(chunk({}, "stop"));
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		writeFileSync(
			join(profile, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
						api: "openai-completions",
						apiKey: "fixture-key",
						models: [
							{
								id: "scripted",
								name: "Scripted",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 400_000,
								maxTokens: 20_000,
							},
						],
					},
				},
			}),
		);
	});

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.length = 0;
		server.closeAllConnections();
		await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
	});

	function start(mode: "print" | "rpc"): { child: ChildProcess; exited: Promise<Exit>; stderr: () => string } {
		const child = spawn(
			process.execPath,
			[
				"--import",
				sourceResolverUrl,
				cliPath,
				"--offline",
				"--provider",
				"fixture",
				"--model",
				"scripted",
				"--api-key",
				"fixture-key",
				"--no-session",
				"--no-extensions",
				"--no-mcp",
				...(mode === "print" ? ["--print", "run it"] : ["--mode", "rpc"]),
			],
			{
				cwd: directory,
				env: { ...process.env, AMAZME_CODING_AGENT_DIR: profile, AMAZME_DURABLE_TUI: "1", AMAZME_OFFLINE: "1", TMPDIR: temp },
				stdio: [mode === "print" ? "ignore" : "pipe", "pipe", "pipe"],
			},
		);
		children.push(child);
		const errors: string[] = [];
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (text: string) => errors.push(text));
		child.stdout?.resume();
		if (mode === "rpc") child.stdin?.write(`${JSON.stringify({ id: "1", type: "prompt", message: "run it" })}\n`);
		const exited = new Promise<Exit>((resolveExit) => {
			child.once("exit", (code, signal) => resolveExit({ code, signal }));
		});
		return { child, exited, stderr: () => errors.join("") };
	}

	async function within(exited: Promise<Exit>, stderr: () => string): Promise<Exit> {
		return Promise.race([
			exited,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no exit\n${stderr()}`)), 30_000)),
		]);
	}

	/**
	 * An artifact landed in the session's own directory, never loose in the temp directory, and that
	 * directory was created owner-only: the shared temp directory must not expose session output.
	 */
	function expectArtifactWritten(entries: string[]): void {
		expect(entries.some((entry) => /\/pi-output-[0-9a-f-]+\.log$/.test(entry)), entries.join("\n")).toBe(true);
		expect(modesDuringTurn.map((mode) => mode.toString(8))).toEqual(["700"]);
	}

	function expectNothingLeft(stderr: string): void {
		expect(readdirSync(temp), stderr).toEqual([]);
	}

	it("removes it after a normal print-mode exit", async () => {
		const { exited, stderr } = start("print");
		expectArtifactWritten(await duringTurn);
		expect(await within(exited, stderr), stderr()).toEqual({ code: 0, signal: null });
		expectNothingLeft(stderr());
	}, 60_000);

	for (const { mode, signal, code } of [
		{ mode: "print", signal: "SIGTERM", code: 143 },
		{ mode: "print", signal: "SIGINT", code: 130 },
		{ mode: "rpc", signal: "SIGTERM", code: 143 },
		// Root cause: RPC mode had no SIGINT listener, so the default action killed it before close.
		{ mode: "rpc", signal: "SIGINT", code: 130 },
		// A closed terminal window sends SIGHUP.
		{ mode: "print", signal: "SIGHUP", code: 129 },
		{ mode: "rpc", signal: "SIGHUP", code: 129 },
	] as const) {
		it(`removes it when ${mode} mode exits on ${signal} after writing an artifact`, async () => {
			answer = false;
			const { child, exited, stderr } = start(mode);
			expectArtifactWritten(await duringTurn);
			child.kill(signal);
			expect(await within(exited, stderr), stderr()).toEqual({ code, signal: null });
			expectNothingLeft(stderr());
		}, 60_000);
	}

	it.skipIf(!hasPython)("removes it when the interactive TUI's terminal window closes after writing an artifact", async () => {
		answer = false;
		// The TUI owns a real pseudo-terminal. Closing its master side is what closing the window does:
		// the kernel sends SIGHUP to the TUI, and later writes to the terminal fail.
		const child = spawn(
			"python3",
			[
				ptyHangup,
				process.execPath,
				"--import",
				sourceResolverUrl,
				cliPath,
				"--offline",
				"--provider",
				"fixture",
				"--model",
				"scripted",
				"--api-key",
				"fixture-key",
				"--no-session",
				"--no-extensions",
				"--no-mcp",
				"run it",
			],
			{
				cwd: directory,
				env: { ...process.env, AMAZME_CODING_AGENT_DIR: profile, AMAZME_DURABLE_TUI: "1", AMAZME_OFFLINE: "1", TMPDIR: temp, TERM: "xterm-256color" },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		children.push(child);
		let printed = "";
		let errors = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (text: string) => {
			printed += text;
		});
		child.stderr?.on("data", (text: string) => {
			errors += text;
		});
		const exited = new Promise<Exit>((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
		expectArtifactWritten(await duringTurn);
		child.stdin?.write("hangup\n");
		expect(await within(exited, () => `${printed}\n${errors}`), errors).toEqual({ code: 0, signal: null });
		// The TUI's own status: a graceful close (exit 0), not the default action of SIGHUP.
		expect(JSON.parse(printed.trim()), errors).toEqual({ code: 0, signal: null });
		expectNothingLeft(errors);
	}, 60_000);

	it("removes it when the process leaves through process.exit without releasing", async () => {
		// The forced-exit shape: a written artifact, no release, and an immediate process.exit.
		const script = [
			`const { selectSession } = await import(${JSON.stringify(sessionsUrl)});`,
			`const { writeFileSync, mkdirSync } = await import("node:fs");`,
			`const location = await selectSession(process.cwd(), false, { noSession: true });`,
			`mkdirSync(location.artifactDirectory, { recursive: true });`,
			`writeFileSync(location.artifactDirectory + "/output.txt", "spill");`,
			`process.stdout.write(location.artifactDirectory);`,
			`process.exit(130);`,
		].join("\n");
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, "--input-type=module", "-e", script], {
			cwd: directory,
			env: { ...process.env, TMPDIR: temp },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);
		let printed = "";
		let errors = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (text: string) => {
			printed += text;
		});
		child.stderr?.on("data", (text: string) => {
			errors += text;
		});
		const exited = new Promise<Exit>((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
		expect(await within(exited, () => errors), errors).toEqual({ code: 130, signal: null });
		expect(printed.startsWith(join(temp, ARTIFACTS)), `${printed}\n${errors}`).toBe(true);
		expect(existsSync(printed)).toBe(false);
		expectNothingLeft(errors);
	}, 30_000);
});
