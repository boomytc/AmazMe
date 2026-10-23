import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCoordinator, type CoordinatorStartupLease } from "../src/host/coordinator.ts";
import { createTempDir } from "./temp-dir.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "support/legacy-host-cli.ts");
const serverId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
// macOS sun_path holds 103 bytes and the runner TMPDIR is deep; tests that bind sockets themselves use /tmp.
const shortTmp = "/tmp";

describe.skipIf(process.platform === "win32")("backend socket lifecycle", () => {
	const children: ChildProcess[] = [];
	const extras: Server[] = [];
	const registrations: Socket[] = [];
	const leases: CoordinatorStartupLease[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.length = 0;
		for (const socket of registrations.splice(0)) socket.destroy();
		for (const lease of leases.splice(0)) {
			lease.close();
			await lease.stop?.().catch(() => undefined);
		}
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
		const directory = createTempDir("am-socket-kill-");
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

	it("keeps the live backend of a server until that server closes after replacement", async () => {
		const directory = createTempDir("am-socket-replace-");
		directories.push(directory);
		await mkdir(join(directory, "agent"), { recursive: true });
		const first = await startServer(directory);
		const [firstBackend] = await backendSockets(first.socketDirectory);
		expect(firstBackend).toBeDefined();

		// Same logical server: the coordinator tells the first one it was replaced and keeps the new endpoint.
		const replacement = await startServer(directory);
		const alive = () => first.child.exitCode === null && first.child.signalCode === null;
		if (alive()) await once(first.child, "exit");

		// Its own close removes it; the replacement's socket stays live and the directory holds nothing stale.
		for (let wait = 0; !(await missing(firstBackend!)); wait++) {
			if (wait > 200) throw new Error(`first server close did not remove ${firstBackend!}`);
			await new Promise((tick) => setTimeout(tick, 25));
		}
		const [replacementBackend] = await backendSockets(replacement.socketDirectory);
		expect(replacementBackend).toBeDefined();
		expect(replacementBackend).not.toBe(firstBackend);
		expect((await lstat(replacementBackend!)).isSocket()).toBe(true);
		expect(await canConnect(replacementBackend!)).toBe(true);
		expect(await canConnect(replacement.publicPath)).toBe(true);
		expect(await backendSockets(replacement.socketDirectory)).toEqual([replacementBackend]);
	});

	it("leaves the live sockets in place when a client discovers the server", async () => {
		const directory = createTempDir("am-socket-client-");
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

	async function startCoordinator(directory: string): Promise<string> {
		const controlPath = join(directory, "control.sock");
		const lease = await ensureCoordinator(join(directory, "public.sock"), controlPath);
		leases.push(lease);
		return controlPath;
	}

	async function listenAt(path: string): Promise<void> {
		const server = createServer();
		extras.push(server);
		await new Promise<void>((done, fail) => {
			server.once("error", fail);
			server.listen(path, done);
		});
	}

	/** Register a backend endpoint with the real coordinator process, as `CoordinatorConnection.connect` does. */
	async function register(controlPath: string, endpoint: string): Promise<Socket> {
		const socket = createConnection(controlPath);
		registrations.push(socket);
		await once(socket, "connect");
		socket.setEncoding("utf8");
		const registered = new Promise<void>((done, fail) => {
			let buffered = "";
			socket.on("data", (chunk: string) => {
				buffered += chunk;
				if (!buffered.includes("\n")) return;
				const message = JSON.parse(buffered.slice(0, buffered.indexOf("\n"))) as { type?: string };
				if (message.type === "server_registered") done();
			});
			socket.once("error", fail);
		});
		socket.write(
			`${JSON.stringify({
				type: "register_server",
				protocol: 5,
				serverConnectionId: crypto.randomUUID(),
				endpoint,
			})}\n`,
		);
		await registered;
		return socket;
	}

	/** A socket file with no listener: a child binds it and is killed, so the path keeps the refused socket. */
	async function refusedSocket(path: string): Promise<{ dev: number; ino: number }> {
		const child = spawn(
			process.execPath,
			["-e", "require('net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))", path],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		children.push(child);
		await new Promise<void>((done, fail) => {
			child.stdout?.setEncoding("utf8");
			child.stdout?.once("data", (chunk: string) => {
				if (chunk.includes("ready")) done();
			});
			child.once("error", fail);
		});
		child.kill("SIGKILL");
		await once(child, "exit");
		const stats = await lstat(path);
		return { dev: stats.dev, ino: stats.ino };
	}

	async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!(await check())) {
			if (Date.now() > deadline) throw new Error("Condition was not reached");
			await new Promise((wait) => setTimeout(wait, 25));
		}
	}

	it("keeps a live backend endpoint when the coordinator replaces its server", async () => {
		const directory = createTempDir("amsp-", { baseDirectory: shortTmp });
		directories.push(directory);
		const controlPath = await startCoordinator(directory);
		const firstPath = join(directory, `server-${serverId}-aaaaaaaaaaaa.sock`);
		const nextPath = join(directory, `server-${serverId}-bbbbbbbbbbbb.sock`);
		await listenAt(firstPath);
		await listenAt(nextPath);
		const first = await register(controlPath, firstPath);
		await register(controlPath, nextPath);
		// Replacement schedules cleanup of the previous endpoint; a live listener must stop it.
		await new Promise((wait) => setTimeout(wait, 300));
		expect((await lstat(firstPath)).isSocket()).toBe(true);
		expect((await lstat(nextPath)).isSocket()).toBe(true);
		first.destroy();
		await new Promise((wait) => setTimeout(wait, 300));
		expect((await lstat(firstPath)).isSocket()).toBe(true);
	});

	it("removes a refused backend endpoint it registered", async () => {
		const directory = createTempDir("amsp-", { baseDirectory: shortTmp });
		directories.push(directory);
		const controlPath = await startCoordinator(directory);
		const path = join(directory, `server-${serverId}-cccccccccccc.sock`);
		await refusedSocket(path);
		const registration = await register(controlPath, path);
		registration.destroy();
		await eventually(() => missing(path));
	});

	it("refuses to register a backend endpoint longer than the platform socket path limit", async () => {
		const directory = createTempDir("amsp-", { baseDirectory: shortTmp });
		directories.push(directory);
		const controlPath = await startCoordinator(directory);
		const endpoint = join(directory, `${"x".repeat(120)}-server-${serverId}-eeeeeeeeeeee.sock`);
		const socket = createConnection(controlPath);
		registrations.push(socket);
		await once(socket, "connect");
		socket.setEncoding("utf8");
		let received = "";
		socket.on("data", (chunk: string) => {
			received += chunk;
		});
		socket.on("error", () => {});
		socket.write(
			`${JSON.stringify({ type: "register_server", protocol: 5, serverConnectionId: crypto.randomUUID(), endpoint })}\n`,
		);
		await once(socket, "close");
		expect(received).not.toContain("server_registered");
	});

	it("does not remove a different socket that reused the registered path", async () => {
		const directory = createTempDir("amsp-", { baseDirectory: shortTmp });
		directories.push(directory);
		const controlPath = await startCoordinator(directory);
		const path = join(directory, `server-${serverId}-dddddddddddd.sock`);
		const registered = await refusedSocket(path);
		const registration = await register(controlPath, path);
		await unlink(path);
		const replacement = await refusedSocket(path);
		expect(replacement.ino).not.toBe(registered.ino);
		registration.destroy();
		// The refused path is not the inode the coordinator recorded, so it belongs to someone else.
		await new Promise((wait) => setTimeout(wait, 500));
		expect((await lstat(path)).isSocket()).toBe(true);
	});

	it("self-heals after both the server and coordinator are killed", async () => {
		const directory = createTempDir("am-socket-both-");
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
