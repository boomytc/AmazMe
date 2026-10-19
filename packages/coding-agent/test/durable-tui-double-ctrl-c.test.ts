import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SHUTDOWN_FORCE_EXIT_MESSAGE } from "../src/utils/shutdown-signals.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");

/**
 * Run the CLI on a pty and press Ctrl-C twice: in one write for mode `together`, or separated by mode `gap:<ms>`.
 * The helper reports every byte the child wrote and how it ended (`CHILD exited <code>`).
 */
const ptyHelper = `
import os, pty, select, signal, sys, time

payload = sys.argv[1]
argv = sys.argv[2:]

pid, fd = pty.fork()
if pid == 0:
    try:
        import fcntl, struct, termios
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    except Exception:
        pass
    os.execvpe(argv[0], argv, os.environ)

def stop(_signum, _frame):
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    raise SystemExit(1)

signal.signal(signal.SIGTERM, stop)
os.set_blocking(fd, False)
seen = b""
pressed = False
status = None
while status is None:
    readable, _, _ = select.select([fd], [], [], 0.02)
    for _item in readable:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if data:
            os.write(sys.stdout.fileno(), data)
            seen += data
            if not pressed and b"AmazMe v" in seen:
                if payload == "together":
                    os.write(fd, b"\\x03\\x03")
                elif payload.startswith("gap:"):
                    os.write(fd, b"\\x03")
                    time.sleep(int(payload.split(":")[1]) / 1000.0)
                    os.write(fd, b"\\x03")
                else:
                    os.write(fd, b"\\x03")
                pressed = True
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
if os.WIFSIGNALED(status):
    sys.stderr.write("CHILD signaled %d\\n" % os.WTERMSIG(status))
else:
    sys.stderr.write("CHILD exited %d\\n" % os.WEXITSTATUS(status))
`;

describe.skipIf(process.platform === "win32")("durable TUI double Ctrl-C", () => {
	const children: ChildProcess[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.length = 0;
		await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
		directories.length = 0;
	});

	for (const payload of ["together", "gap:1", "gap:3", "gap:10"]) {
		it(`force-exits 130 without echoing ^C when both presses arrive (${payload})`, async () => {
			const { stdout, ending } = await run(payload);
			expect(ending, stdout).toBe("CHILD exited 130");
			expect(stdout).toContain("\x1b[?1049l");
			expect(stdout).toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
			expect(stdout).not.toContain("^C");
		}, 45_000);
	}

	it("still exits 0 gracefully for a single Ctrl-C", async () => {
		const { stdout, ending } = await run("single");
		expect(ending, stdout).toBe("CHILD exited 0");
		expect(stdout).not.toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
		expect(stdout).not.toContain("^C");
	}, 45_000);

	async function run(payload: string): Promise<{ stdout: string; ending: string | undefined }> {
		const directory = await mkdtemp(join(tmpdir(), "am-double-ctrl-c-"));
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
						baseUrl: "http://127.0.0.1:9/v1",
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
				payload === "single" ? "single" : payload,
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
		await Promise.race([
			exited,
			new Promise((_, rejectWait) =>
				setTimeout(
					() =>
						rejectWait(new Error(`no exit\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`)),
					30_000,
				),
			),
		]);
		const ending = stderr
			.join("")
			.split("\n")
			.find((line) => line.startsWith("CHILD "));
		return { stdout: stdout.join(""), ending };
	}
});
