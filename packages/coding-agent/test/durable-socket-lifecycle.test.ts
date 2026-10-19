import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");
const serverId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe.skipIf(process.platform === "win32")("backend socket lifecycle", () => {
	const children: ChildProcess[] = [];
	const extras: Server[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.length = 0;
		for (const server of extras.splice(0)) await new Promise<void>((done) => server.close(() => done()));
		await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
		directories.length = 0;
	});

	interface Running {
		readonly child: ChildProcess;
		readonly publicPath: string;
		readonly socketDirectory: string;
	}

	async function startServer(directory: string): Promise<Running> {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const child = spawn(
			process.execPath,
			["--import", sourceResolverUrl, cliPath, "server", "--server-id", serverId, "--session-dir", join(directory, "sessions")],
			{
				cwd: directory,
				env: {
					...process.env,
					AMAZME_CODING_AGENT_DIR: join(directory, "agent"),
					AMAZME_SERVER_DIR: join(directory, "server"),
					AMAZME_OFFLINE: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.push(child);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null || child.signalCode !== null) break;
			const match = /^Socket: (\S+)/m.exec(stdout.join(""));
			if (match?.[1] !== undefined) {
				return { child, publicPath: match[1], socketDirectory: dirname(match[1]) };
			}
			await new Promise((wait) => setTimeout(wait, 20));
		}
		throw new Error(`server did not publish a socket\n${stdout.join("")}\n${stderr.join("")}`);
	}

	async function backendSockets(directory: string): Promise<string[]> {
		const { readdir } = await import("node:fs/promises");
		return (await readdir(directory))
			.filter((name) => new RegExp(`^server-${serverId}-[0-9a-f]{12}\\.sock$`).test(name))
			.map((name) => join(directory, name));
	}

	async function missing(path: string): Promise<boolean> {
		return lstat(path).then(
			() => false,
			(error: NodeJS.ErrnoException) => error.code === "ENOENT",
		);
	}

	async function canConnect(path: string): Promise<boolean> {
		return new Promise((done) => {
			const socket = createConnection(path);
			socket.once("connect", () => {
				socket.destroy();
				done(true);
			});
			socket.once("error", () => done(false));
		});
	}

	it("removes the backend socket after the server is SIGKILLed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "am-socket-kill-"));
		directories.push(directory);
		await mkdir(join(directory, "agent"), { recursive: true });
		const running = await startServer(directory);
		const [backend] = await backendSockets(running.socketDirectory);
		expect(backend).toBeDefined();
		expect((await lstat(backend!)).isSocket()).toBe(true);
		running.child.kill("SIGKILL");
		await once(running.child, "exit");
		// The coordinator owns the cleanup after its server connection closes.
		const deadline = Date.now() + 10_000;
		while (!(await missing(backend!))) {
			if (Date.now() > deadline) throw new Error(`coordinator did not remove ${backend!}`);
			await new Promise((wait) => setTimeout(wait, 50));
		}
	});

	it("leaves the live sockets in place when a client discovers the server", async () => {
		const directory = await mkdtemp(join(tmpdir(), "am-socket-client-"));
		directories.push(directory);
		await mkdir(join(directory, "agent"), { recursive: true });
		const running = await startServer(directory);
		const [backend] = await backendSockets(running.socketDirectory);
		expect(backend).toBeDefined();
		const client = spawn(
			process.execPath,
			["--import", sourceResolverUrl, cliPath, "client", "--connect", `unix://${running.publicPath}`],
			{
				cwd: directory,
				env: {
					...process.env,
					AMAZME_CODING_AGENT_DIR: join(directory, "agent"),
					AMAZME_SERVER_DIR: join(directory, "server"),
					AMAZME_OFFLINE: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.push(client);
		const [code] = (await once(client, "exit")) as [number | null, NodeJS.Signals | null];
		expect(code).toBe(0);
		expect((await lstat(running.publicPath)).isSocket()).toBe(true);
		expect((await lstat(backend!)).isSocket()).toBe(true);
	});

	it("self-heals after both the server and coordinator are killed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "am-socket-both-"));
		directories.push(directory);
		await mkdir(join(directory, "agent"), { recursive: true });
		const first = await startServer(directory);
		const [backend] = await backendSockets(first.socketDirectory);
		expect(backend).toBeDefined();
		const coordinatorPid = Number(
			execFileSync("pgrep", ["-P", String(first.child.pid)]).toString().trim().split("\n")[0],
		);
		expect(Number.isSafeInteger(coordinatorPid) && coordinatorPid > 0).toBe(true);

		// A matching live socket and a same-name regular file must survive the startup scan.
		const live = createServer();
		extras.push(live);
		const livePath = join(first.socketDirectory, `server-${serverId}-aaaaaaaaaaaa.sock`);
		await new Promise<void>((done) => live.listen(livePath, done));
		const regularPath = join(first.socketDirectory, `server-${serverId}-bbbbbbbbbbbb.sock`);
		await writeFile(regularPath, "not a socket");

		first.child.kill("SIGKILL");
		process.kill(coordinatorPid, "SIGKILL");
		await once(first.child, "exit");
		expect(await missing(backend!)).toBe(false);

		const second = await startServer(directory);
		expect(await missing(backend!)).toBe(true);
		expect(await canConnect(second.publicPath)).toBe(true);
		expect(await canConnect(livePath)).toBe(true);
		expect((await lstat(regularPath)).isFile()).toBe(true);
	});
});
