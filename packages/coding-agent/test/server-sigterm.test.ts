import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");
const serverId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe.skipIf(process.platform === "win32")("server SIGTERM", () => {
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

	it("unlinks its socket and empty hash directory, then exits", async () => {
		const uid = process.getuid();
		if (uid === undefined) throw new Error("expected a POSIX user id");
		const scratch = await mkdtemp(join("/tmp", "am-sigterm-"));
		directories.push(scratch);
		const logical = join("/tmp", "d".repeat(80), "srv");
		directories.push(dirname(logical));
		const sessionDir = join(scratch, "sessions");
		const agentDir = join(scratch, "agent");
		await mkdir(sessionDir, { recursive: true });
		const sibling = join("/tmp", `am-${uid}`, "ffffffffffff");
		await mkdir(sibling, { recursive: true });
		directories.push(sibling);
		await writeFile(join(sibling, "keep"), "other process");

		const stdout: string[] = [];
		const stderr: string[] = [];
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, "server", "--server-id", serverId, "--session-dir", sessionDir], {
			cwd: scratch,
			env: {
				...process.env,
				AMAZME_CODING_AGENT_DIR: agentDir,
				AMAZME_SERVER_DIR: logical,
				AMAZME_OFFLINE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

		const socketPath = await readSocketPath(stdout, stderr, child);
		expect(dirname(dirname(socketPath))).toBe(join("/tmp", `am-${uid}`));
		const hashDirectory = dirname(socketPath);
		expect((await lstat(socketPath)).isSocket()).toBe(true);

		const exited = once(child, "exit");
		child.kill("SIGTERM");
		// The first handler returns immediately. A second SIGTERM in that window
		// used to be re-sent by signal-exit and kill the process before unlink.
		await new Promise((resolve) => setTimeout(resolve, 5));
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];

		expect(signal).toBeNull();
		expect(code).toBe(0);
		await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(hashDirectory)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await lstat(sibling)).isDirectory()).toBe(true);
		expect(await lstat(join(sibling, "keep"))).toBeTruthy();
	});
});

async function readSocketPath(stdout: readonly string[], stderr: readonly string[], child: ChildProcess): Promise<string> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) break;
		const match = /^Socket: (\S+)/m.exec(stdout.join(""));
		if (match?.[1]) return match[1];
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`server did not publish a socket\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`);
}
