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
 * Runs the CLI on a pty. A line on stdin is written to the pty as raw bytes.
 * Mode `restore`: the first time the pty shows the alt-screen exit after a Ctrl-C byte
 * was written, the helper sends the child a real SIGINT, while cleanup is still running.
 * Mode `unlock:<dir>`: after that alt-screen exit, the helper sends the SIGINT as soon as
 * no session lock is left under `<dir>`, between the end of cleanup and process exit.
 * The last stderr line reports how the child ended: `CHILD exited <code>` or `CHILD signaled <n>`.
 */
const ptyHelper = `
import os, pty, select, signal, sys

mode = sys.argv[1]
argv = sys.argv[2:]

def locked(directory):
    for _root, dirs, _files in os.walk(directory):
        if any(name.endswith(".lock") for name in dirs):
            return True
    return False

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
os.set_blocking(sys.stdin.fileno(), False)
stdin_open = True
pressed = False
signaled = False
restored_at_unlock = False
seen = b""
status = None
while status is None:
    watch = [fd]
    if stdin_open:
        watch.append(sys.stdin.fileno())
    readable, _, _ = select.select(watch, [], [], 0.001 if restored_at_unlock else 0.05)
    for item in readable:
        if item == fd:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if data:
                os.write(sys.stdout.fileno(), data)
                if pressed and not signaled:
                    seen += data
                    restored = b"\\x1b[?1049l" in seen
                    if mode == "restore" and restored:
                        os.kill(pid, signal.SIGINT)
                        signaled = True
                    elif mode.startswith("unlock:") and restored:
                        restored_at_unlock = True
        else:
            try:
                data = os.read(sys.stdin.fileno(), 65536)
            except OSError:
                data = b""
            if data:
                os.write(fd, data)
                if b"\\x03" in data:
                    pressed = True
            else:
                stdin_open = False
    if restored_at_unlock and not signaled and not locked(mode[len("unlock:"):]):
        os.kill(pid, signal.SIGINT)
        signaled = True
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

describe.skipIf(process.platform === "win32")("durable TUI Ctrl-C then SIGINT", () => {
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

	it("exits 0 without the force-exit message after one Ctrl-C", async () => {
		const { stdout, ending } = await run("none");
		expect(ending, stdout).toBe("CHILD exited 0");
		expect(stdout).not.toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	}, 45_000);

	it("is not killed by a SIGINT after cleanup released the session lock", async () => {
		const { stdout, ending } = await run("unlock");
		expect(ending, stdout).toMatch(/^CHILD exited (0|130)$/);
	}, 45_000);

	it("force-exits 130 with the message when a SIGINT arrives after the screen is restored", async () => {
		const { stdout, ending } = await run("restore");
		expect(ending, stdout).toBe("CHILD exited 130");
		expect(stdout).toContain(`\r\x1b[K${SHUTDOWN_FORCE_EXIT_MESSAGE}`);
	}, 45_000);

	async function run(mode: "none" | "restore" | "unlock"): Promise<{ stdout: string; ending: string | undefined }> {
		const directory = await mkdtemp(join(tmpdir(), "am-sigint-"));
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
				mode === "unlock" ? `unlock:${sessionDir}` : mode,
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

		const deadline = Date.now() + 20_000;
		while (!stdout.join("").includes("AmazMe v")) {
			if (Date.now() > deadline || child.exitCode !== null) {
				throw new Error(`no startup banner\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`);
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		}
		child.stdin?.write("\x03");
		await Promise.race([
			exited,
			new Promise((_, rejectWait) =>
				setTimeout(() => rejectWait(new Error(`no exit\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`)), 20_000),
			),
		]);
		const ending = stderr
			.join("")
			.split("\n")
			.find((line) => line.startsWith("CHILD "));
		return { stdout: stdout.join(""), ending };
	}
});
