import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir } from "./temp-dir.ts";
import {
	closeWhenSignaled,
	forceShutdownExitLine,
	SHUTDOWN_FORCE_EXIT_CODE,
	SHUTDOWN_FORCE_EXIT_MESSAGE,
} from "../src/utils/shutdown-signals.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const fixturePath = resolve(__dirname, "shutdown-signals-fixture.ts");

describe.skipIf(process.platform === "win32")("shutdown signals", () => {
	const children: ChildProcess[] = [];

	afterEach(() => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.length = 0;
	});

	it("exits 0 after one SIGINT once cleanup finishes", async () => {
		const child = spawnFixture("ok");
		const stdout: string[] = [];
		const stderr: string[] = [];
		collect(child, stdout, stderr);
		await waitFor(stdout, "ready\n", child, stderr);
		child.kill("SIGINT");
		const [code, signal] = await childExit(child);
		expect(signal).toBeNull();
		expect(code).toBe(0);
		expect(stdout.join("")).toContain("closed\n");
		expect(stderr.join("")).not.toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	});

	it("force-exits within 1s when cleanup hangs and a second SIGINT arrives", async () => {
		const child = spawnFixture("hang");
		const stdout: string[] = [];
		const stderr: string[] = [];
		collect(child, stdout, stderr);
		await waitFor(stdout, "ready\n", child, stderr);
		child.kill("SIGINT");
		await waitFor(stdout, "closing\n", child, stderr);
		expect(child.exitCode).toBeNull();
		const started = Date.now();
		const pending = childExit(child);
		child.kill("SIGINT");
		const [code, signal] = await pending;
		expect(Date.now() - started).toBeLessThan(1000);
		expect(signal).toBeNull();
		expect(code).toBe(SHUTDOWN_FORCE_EXIT_CODE);
		expect(stderr.join("")).toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
		expect(stdout.join("")).not.toContain("closed\n");
	});

	it("keeps running through a second SIGTERM while cleanup is still in progress", async () => {
		const child = spawnFixture("slow");
		const stdout: string[] = [];
		const stderr: string[] = [];
		collect(child, stdout, stderr);
		await waitFor(stdout, "ready\n", child, stderr);
		child.kill("SIGTERM");
		await waitFor(stdout, "closing\n", child, stderr);
		child.kill("SIGTERM");
		const [code, signal] = await childExit(child);
		expect(signal).toBeNull();
		expect(code).toBe(0);
		expect(stdout.join("")).toContain("closed\n");
		expect(stderr.join("")).not.toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	});

	it("keeps running through a second SIGHUP while cleanup is still in progress", async () => {
		const child = spawnFixture("slow");
		const stdout: string[] = [];
		const stderr: string[] = [];
		collect(child, stdout, stderr);
		await waitFor(stdout, "ready\n", child, stderr);
		child.kill("SIGHUP");
		await waitFor(stdout, "closing\n", child, stderr);
		child.kill("SIGHUP");
		const [code, signal] = await childExit(child);
		expect(signal).toBeNull();
		expect(code).toBe(0);
		expect(stdout.join("")).toContain("closed\n");
		expect(stderr.join("")).not.toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	});

	for (const sent of ["SIGTERM", "SIGHUP"] as const) {
		it(`unlinks the socket when ${sent} arrives before listen`, async () => {
			const socketPath = join(createTempDir("am-sock-"), "s.sock");
			const child = spawnFixture("socket", true, [socketPath]);
			const stdout: string[] = [];
			const stderr: string[] = [];
			collect(child, stdout, stderr);
			// `binding` is printed inside `start`: the listeners are up, the socket does not exist yet.
			await waitFor(stdout, "binding\n", child, stderr);
			await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
			child.kill(sent);
			// Let the handler run before the socket is bound, then let `start` listen.
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(child.exitCode).toBeNull();
			child.stdin?.write("listen\n");
			const [code, signal] = await childExit(child);
			expect(signal).toBeNull();
			expect(code).toBe(0);
			const text = stdout.join("");
			expect(text).toContain("listening\n");
			expect(text).toContain("closing\n");
			// The signal was seen before `arm`: readiness is never announced for a closing server.
			expect(text).not.toContain("ready\n");
			await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it(`unlinks the socket when ${sent} arrives after listen`, async () => {
			const socketPath = join(createTempDir("am-sock-"), "s.sock");
			const child = spawnFixture("socket", true, [socketPath]);
			const stdout: string[] = [];
			const stderr: string[] = [];
			collect(child, stdout, stderr);
			await waitFor(stdout, "binding\n", child, stderr);
			child.stdin?.write("listen\n");
			await waitFor(stdout, "ready\n", child, stderr);
			expect((await lstat(socketPath)).isSocket()).toBe(true);
			child.kill(sent);
			const [code, signal] = await childExit(child);
			expect(signal).toBeNull();
			expect(code).toBe(0);
			expect(stdout.join("")).toContain("closing\n");
			await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
		});
	}

	it("force-exits when SIGTERM started cleanup and a SIGINT follows", async () => {
		const child = spawnFixture("hang");
		const stdout: string[] = [];
		const stderr: string[] = [];
		collect(child, stdout, stderr);
		await waitFor(stdout, "ready\n", child, stderr);
		child.kill("SIGTERM");
		await waitFor(stdout, "closing\n", child, stderr);
		const started = Date.now();
		const pending = childExit(child);
		child.kill("SIGINT");
		const [code, signal] = await pending;
		expect(Date.now() - started).toBeLessThan(1000);
		expect(signal).toBeNull();
		expect(code).toBe(SHUTDOWN_FORCE_EXIT_CODE);
		expect(stderr.join("")).toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	});

	it("treats a second Ctrl-C key during cleanup as a force exit", async () => {
		const child = spawnFixture("key", true);
		const stdout: string[] = [];
		const stderr: string[] = [];
		collect(child, stdout, stderr);
		await waitFor(stdout, "ready\n", child, stderr);
		child.stdin?.write("c\n");
		await waitFor(stdout, "armed\n", child, stderr);
		expect(child.exitCode).toBeNull();
		const started = Date.now();
		const pending = childExit(child);
		child.stdin?.write("c\n");
		const [code, signal] = await pending;
		expect(Date.now() - started).toBeLessThan(1000);
		expect(signal).toBeNull();
		expect(code).toBe(SHUTDOWN_FORCE_EXIT_CODE);
		expect(stderr.join("")).toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	});

	it("force-exits when the first interrupt was a key and a SIGINT follows", async () => {
		const child = spawnFixture("key", true);
		const stdout: string[] = [];
		const stderr: string[] = [];
		collect(child, stdout, stderr);
		await waitFor(stdout, "ready\n", child, stderr);
		child.stdin?.write("c\n");
		await waitFor(stdout, "armed\n", child, stderr);
		const started = Date.now();
		const pending = childExit(child);
		child.kill("SIGINT");
		const [code, signal] = await pending;
		expect(Date.now() - started).toBeLessThan(1000);
		expect(signal).toBeNull();
		expect(code).toBe(SHUTDOWN_FORCE_EXIT_CODE);
		expect(stderr.join("")).toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	});

	function spawnFixture(mode: string, stdin = false, extra: readonly string[] = []): ChildProcess {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, fixturePath, mode, ...extra], {
			stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		children.push(child);
		return child;
	}
});

function collect(child: ChildProcess, stdout: string[], stderr: string[]): void {
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
}

/** Exit status, after stdout and stderr have closed so the collected text is complete. */
function childExit(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
	const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
	return exited.then(async (result) => {
		await Promise.all([ended(child.stdout), ended(child.stderr)]);
		return result;
	});
}

function ended(stream: Readable | null | undefined): Promise<void> {
	if (stream === null || stream === undefined || stream.readableEnded) return Promise.resolve();
	return new Promise((resolve) => {
		stream.on("end", () => resolve());
	});
}

async function waitFor(
	stdout: readonly string[],
	needle: string,
	child: ChildProcess,
	stderr: readonly string[],
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (stdout.join("").includes(needle)) return;
		if (child.exitCode !== null || child.signalCode !== null) break;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(
		`timed out waiting for ${JSON.stringify(needle)}\nstdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}\nexit:${String(child.exitCode)} signal:${String(child.signalCode)}`,
	);
}

describe("closeWhenSignaled shape", () => {
	it("cannot be handed a resource that is already listening", () => {
		const running = { closed: Promise.resolve(), close: async () => {} };
		// Neither old order type-checks: listening first and then passing the result is not expressible.
		// @ts-expect-error A started resource is not a `start` callback.
		const startedFirst = () => closeWhenSignaled(running, () => {});
		// @ts-expect-error The removed `(closed, close, arm)` shape.
		const oldShape = () => closeWhenSignaled(running.closed, () => running.close(), () => {});
		// Never called: the two `@ts-expect-error` lines are the assertion, checked by tsc.
		void startedFirst;
		void oldShape;
	});
});

describe("force-exit line", () => {
	it("clears the echoed ^C on a terminal and writes the plain message to a pipe", () => {
		expect(forceShutdownExitLine(true)).toBe(`\r\x1b[K${SHUTDOWN_FORCE_EXIT_MESSAGE}\n`);
		expect(forceShutdownExitLine(false)).toBe(`${SHUTDOWN_FORCE_EXIT_MESSAGE}\n`);
	});
});
