import { describe, expect, test, vi } from "vitest";
import { createHostSupervisor, MAX_HOST_OUTPUT_CHARS, spawnNodeChild, type HostExitDetail, type HostStartupFailure } from "../src/host.ts";
import { fakeHost, pythonReadyLine } from "./fake-host.ts";

describe("host supervisor", () => {
	test("resolves the page URL and stops the child", async () => {
		const fake = fakeHost();
		const logged: string[] = [];
		const supervisor = createHostSupervisor({
			spawnHost: () => fake.child,
			log: (chunk) => {
				logged.push(chunk);
			},
		});
		const pending = supervisor.start();
		fake.emitStdout("Mode: source\n");
		fake.emitStdout(`${pythonReadyLine(4310)}\n`);
		await expect(pending).resolves.toBe("http://127.0.0.1:4310/");
		expect(logged.join("")).toContain(pythonReadyLine(4310));
		const stopped = supervisor.shutdown();
		expect(fake.kills).toEqual(["SIGTERM"]);
		fake.emitExit(null, "SIGTERM");
		await stopped;
	});

	test("keeps reading after the launch line so later output is not stuck in the pipe", async () => {
		const fake = fakeHost();
		const logged: string[] = [];
		const supervisor = createHostSupervisor({
			spawnHost: () => fake.child,
			log: (chunk) => {
				logged.push(chunk);
			},
		});
		const pending = supervisor.start();
		fake.emitStdout(`${pythonReadyLine(1)}\n`);
		await pending;
		fake.emitStderr("still running\n");
		expect(logged.join("")).toContain("still running");
		const stopped = supervisor.shutdown();
		fake.emitExit(0, null);
		await stopped;
	});

	test("fails when the child exits before the launch line", async () => {
		const fake = fakeHost();
		const supervisor = createHostSupervisor({ spawnHost: () => fake.child });
		const pending = supervisor.start();
		const assertion = expect(pending).rejects.toThrow(/exited before readiness \(code 1/);
		fake.emitStdout("Error: boom\n");
		fake.emitExit(1, null);
		await assertion;
	});

	test("accepts a launch line that arrived without a newline before exit", async () => {
		const fake = fakeHost();
		const supervisor = createHostSupervisor({ spawnHost: () => fake.child });
		const pending = supervisor.start();
		fake.emitStdout(pythonReadyLine(9));
		fake.emitExit(0, null);
		await expect(pending).resolves.toBe("http://127.0.0.1:9/");
	});

	test("kills the child when the launch line does not arrive in time", async () => {
		vi.useFakeTimers();
		try {
			const fake = fakeHost();
			const supervisor = createHostSupervisor({
				spawnHost: () => fake.child,
				readinessTimeoutMs: 60_000,
				onStartupFailure: (failure) => {
					expect(failure).toMatchObject({ kind: "readiness-timeout", timeoutMs: 60_000 });
				},
			});
			const pending = supervisor.start();
			const assertion = expect(pending).rejects.toThrow(/timed out after 60000ms/);
			await vi.advanceTimersByTimeAsync(60_000);
			await assertion;
			expect(fake.kills).toContain("SIGTERM");
		} finally {
			vi.useRealTimers();
		}
	});

	test("escalates to SIGKILL when SIGTERM does not exit", async () => {
		vi.useFakeTimers();
		try {
			const fake = fakeHost();
			const supervisor = createHostSupervisor({
				spawnHost: () => fake.child,
				shutdownTimeoutMs: 5_000,
			});
			const pending = supervisor.start();
			fake.emitStdout(`${pythonReadyLine(1)}\n`);
			await expect(pending).resolves.toBe("http://127.0.0.1:1/");
			const stopped = supervisor.shutdown();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(fake.kills).toEqual(["SIGTERM", "SIGKILL"]);
			fake.emitExit(null, "SIGKILL");
			await stopped;
		} finally {
			vi.useRealTimers();
		}
	});

	test("reports a spawn error", async () => {
		const fake = fakeHost();
		const seen: HostStartupFailure[] = [];
		const supervisor = createHostSupervisor({
			spawnHost: () => fake.child,
			onStartupFailure: (failure) => {
				seen.push(failure);
			},
		});
		const pending = supervisor.start();
		const assertion = expect(pending).rejects.toThrow(/failed to spawn: missing/);
		fake.emitStderr("no such file\n");
		fake.emitError(new Error("missing"));
		await assertion;
		expect(seen).toEqual([
			{ kind: "spawn-error", message: "desktop host failed to spawn: missing", tail: "no such file\n" },
		]);
	});

	test("keeps a bounded tail of stdout and stderr after the launch line", async () => {
		const fake = fakeHost();
		const supervisor = createHostSupervisor({ spawnHost: () => fake.child });
		const pending = supervisor.start();
		fake.emitStdout(`${pythonReadyLine(1)}\n`);
		await pending;
		fake.emitStdout("x".repeat(MAX_HOST_OUTPUT_CHARS));
		fake.emitStderr("TAIL");
		expect(supervisor.tail().length).toBe(MAX_HOST_OUTPUT_CHARS);
		expect(supervisor.tail().endsWith("TAIL")).toBe(true);
	});

	test("reports an unexpected exit with the output tail", async () => {
		const fake = fakeHost();
		const seen: HostExitDetail[] = [];
		const supervisor = createHostSupervisor({
			spawnHost: () => fake.child,
			onUnexpectedExit: (detail) => {
				seen.push(detail);
			},
		});
		const pending = supervisor.start();
		fake.emitStdout(`${pythonReadyLine(1)}\n`);
		await pending;
		fake.emitStderr("boom\n");
		fake.emitExit(1, null);
		expect(seen).toEqual([{ code: 1, signal: null, tail: `${pythonReadyLine(1)}\nboom\n` }]);
	});

	test("names an exit before readiness and keeps the output on that failure", async () => {
		const fake = fakeHost();
		const seen: HostStartupFailure[] = [];
		const unexpected: unknown[] = [];
		const supervisor = createHostSupervisor({
			spawnHost: () => fake.child,
			onStartupFailure: (failure) => {
				seen.push(failure);
			},
			onUnexpectedExit: (detail) => {
				unexpected.push(detail);
			},
		});
		const pending = supervisor.start();
		const assertion = expect(pending).rejects.toThrow(/exited before readiness \(code 1, signal null\)\nError: boom\n/);
		fake.emitStdout("Error: boom\n");
		fake.emitExit(1, null);
		await assertion;
		expect(seen).toEqual([
			{
				kind: "exit-before-ready",
				message: "desktop host exited before readiness (code 1, signal null)",
				code: 1,
				signal: null,
				tail: "Error: boom\n",
			},
		]);
		expect(unexpected).toEqual([]);
	});

	test("reads a real process's launch line and stops it", async () => {
		const supervisor = createHostSupervisor({
			spawnHost: () =>
				spawnNodeChild({
					executable: process.execPath,
					args: [
						"-e",
						`process.stdout.write(${JSON.stringify(`noise\n${pythonReadyLine(4310)}\n`)}); setInterval(() => {}, 1000);`,
					],
					cwd: process.cwd(),
					env: process.env,
				}),
		});
		await expect(supervisor.start()).resolves.toBe("http://127.0.0.1:4310/");
		await supervisor.shutdown();
	});

	test("a graceful shutdown waits for natural exit without signaling the owned child", async () => {
		const fake = fakeHost();
		const supervisor = createHostSupervisor({ spawnHost: () => fake.child });
		const starting = supervisor.start();
		fake.emitStdout(`${pythonReadyLine(1)}\n`);
		await starting;
		const request = vi.fn(async () => { fake.emitExit(0, null); });
		await supervisor.shutdown({ request, force: false });
		expect(request).toHaveBeenCalledTimes(1);
		expect(fake.kills).toEqual([]);
	});

	test("a graceful timeout is retryable and never escalates without explicit force", async () => {
		vi.useFakeTimers();
		try {
			const fake = fakeHost();
			const supervisor = createHostSupervisor({ spawnHost: () => fake.child, shutdownTimeoutMs: 5_000 });
			const starting = supervisor.start();
			fake.emitStdout(`${pythonReadyLine(1)}\n`);
			await starting;
			const request = vi.fn(async () => {});
			const stopped = supervisor.shutdown({ request, force: false });
			const assertion = expect(stopped).rejects.toThrow(/shutdown timed out/);
			await vi.advanceTimersByTimeAsync(5_000);
			await assertion;
			expect(fake.kills).toEqual([]);
			fake.emitExit(0, null);
			await supervisor.shutdown({ request, force: false });
			expect(request).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a failed graceful request can be retried and concurrent callers share it", async () => {
		const fake = fakeHost();
		const supervisor = createHostSupervisor({ spawnHost: () => fake.child });
		const starting = supervisor.start();
		fake.emitStdout(`${pythonReadyLine(1)}\n`);
		await starting;
		const request = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockImplementation(async () => { fake.emitExit(0, null); });
		const first = supervisor.shutdown({ request, force: false });
		const concurrent = supervisor.shutdown({ request, force: false });
		await expect(first).rejects.toThrow("unavailable");
		await expect(concurrent).rejects.toThrow("unavailable");
		expect(request).toHaveBeenCalledTimes(1);
		expect(fake.kills).toEqual([]);
		await supervisor.shutdown({ request, force: false });
		expect(request).toHaveBeenCalledTimes(2);
	});
});
