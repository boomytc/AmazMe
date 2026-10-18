import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openDurable } from "../src/durable/runtime.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");

const ptyHelper = `
import os, pty, select, signal, sys

pid, fd = pty.fork()
if pid == 0:
    try:
        import fcntl, struct, termios
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    except Exception:
        pass
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

def stop(_signum, _frame):
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    raise SystemExit(1)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
os.set_blocking(fd, False)
os.set_blocking(sys.stdin.fileno(), False)
stdin_open = True
status = None
while status is None:
    watch = [fd]
    if stdin_open:
        watch.append(sys.stdin.fileno())
    readable, _, _ = select.select(watch, [], [], 0.2)
    for item in readable:
        if item == fd:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if data:
                os.write(sys.stdout.fileno(), data)
        else:
            try:
                data = os.read(sys.stdin.fileno(), 65536)
            except OSError:
                data = b""
            if data:
                os.write(fd, data)
            else:
                stdin_open = False
    waited, waited_status = os.waitpid(pid, os.WNOHANG)
    if waited != 0:
        status = waited_status
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    os.write(sys.stdout.fileno(), data)
code = os.waitstatus_to_exitcode(status)
raise SystemExit(code if code >= 0 else 128 - code)
`;

describe.skipIf(process.platform === "win32")("durable TUI /quit", () => {
	const children: ChildProcess[] = [];
	const directories: string[] = [];
	let server: Server | undefined;

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.length = 0;
		await new Promise<void>((resolveClose) => {
			if (server === undefined) {
				resolveClose();
				return;
			}
			server.close(() => resolveClose());
			server = undefined;
		});
		await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
		directories.length = 0;
	});

	it("exits 0 without a model request or a new user message", async () => {
		const requests: string[] = [];
		server = createServer((request, response) => {
			requests.push(`${request.method ?? "?"} ${request.url ?? ""}`);
			response.writeHead(500);
			response.end("model request was not expected");
		});
		await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("test server did not bind");
		const port = (address as AddressInfo).port;

		const directory = await mkdtemp(join(tmpdir(), "am-quit-"));
		directories.push(directory);
		const cwd = join(directory, "project");
		const profile = join(directory, "profile");
		const sessionDir = join(directory, "sessions");
		await mkdir(cwd);
		await mkdir(profile);
		await writeFile(
			join(profile, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "test-key",
						models: [
							{
								id: "plain",
								name: "Fixture",
								reasoning: false,
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
		await writeFile(join(directory, "pty-helper.py"), ptyHelper);

		const stdout: string[] = [];
		const stderr: string[] = [];
		const child = spawn(
			"python3",
			[
				join(directory, "pty-helper.py"),
				process.execPath,
				"--import",
				sourceResolverUrl,
				cliPath,
				"--offline",
				"--provider",
				"fixture",
				"--model",
				"plain",
				"--api-key",
				"test-key",
				"--session-dir",
				sessionDir,
				"--no-extensions",
				"--no-mcp",
			],
			{
				cwd,
				env: {
					...process.env,
					TERM: "xterm-256color",
					COLUMNS: "120",
					LINES: "40",
					AMAZME_CODING_AGENT_DIR: profile,
					AMAZME_OFFLINE: "1",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		children.push(child);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
		const exited = once(child, "exit");

		await waitForOutput(stdout, stderr, child, (text) => text.includes("AmazMe v"), "startup banner");
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`TUI exited before /quit was sent\n${outputOf(stdout, stderr)}`);
		}
		child.stdin?.write("/quit\r");
		const [code, signal] = (await promiseWithTimeout(
			exited,
			20_000,
			() => `TUI did not exit after /quit\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`,
		)) as [number | null, NodeJS.Signals | null];

		expect(signal, outputOf(stdout, stderr)).toBeNull();
		expect(code, outputOf(stdout, stderr)).toBe(0);
		expect(requests, outputOf(stdout, stderr)).toEqual([]);

		const restored = await openDurable({
			cwd,
			sessionDir,
			continueSession: true,
			noExtensions: true,
			noMcp: true,
			noSkills: true,
			noPromptTemplates: true,
			settingsManager: SettingsManager.inMemory(),
		});
		try {
			const entries = restored.view.current().conversation.entries;
			const users = entries.filter((entry) => entry.model?.some((message) => message.role === "user"));
			expect(users).toEqual([]);
			expect(JSON.stringify(entries)).not.toContain("/quit");
		} finally {
			await restored.close();
		}
	}, 45_000);
});

function outputOf(stdout: readonly string[], stderr: readonly string[]): string {
	return `stdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`;
}

async function waitForOutput(
	stdout: readonly string[],
	stderr: readonly string[],
	child: ChildProcess,
	ready: (text: string) => boolean,
	label: string,
): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) break;
		if (ready(stdout.join(""))) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	}
	throw new Error(
		`did not reach ${label} (code ${String(child.exitCode)}, signal ${String(child.signalCode)})\n${outputOf(stdout, stderr)}`,
	);
}

function promiseWithTimeout<T>(pending: Promise<T>, ms: number, detail: () => string): Promise<T> {
	return new Promise((resolveValue, rejectValue) => {
		const timer = setTimeout(() => rejectValue(new Error(detail())), ms);
		pending.then(
			(value) => {
				clearTimeout(timer);
				resolveValue(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				rejectValue(error);
			},
		);
	});
}
