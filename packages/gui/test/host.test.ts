import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { createHostSupervisor, spawnNodeChild, type HostChild } from "../src/host.ts";

interface FakeHost {
	readonly child: HostChild;
	emitStdout(chunk: string): void;
	emitStderr(chunk: string): void;
	emitExit(code: number | null, signal: NodeJS.Signals | null): void;
	emitError(error: Error): void;
	readonly kills: string[];
}

function fakeHost(): FakeHost {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const events = new EventEmitter();
	const kills: string[] = [];
	const child: HostChild = {
		stdout: {
			onData(listener) {
				stdout.on("data", listener);
				return () => {
					stdout.off("data", listener);
				};
			},
		},
		stderr: {
			onData(listener) {
				stderr.on("data", listener);
				return () => {
					stderr.off("data", listener);
				};
			},
		},
		onExit(listener) {
			events.on("exit", listener);
			return () => {
				events.off("exit", listener);
			};
		},
		onError(listener) {
			events.on("error", listener);
			return () => {
				events.off("error", listener);
			};
		},
		kill(signal) {
			kills.push(signal);
		},
	};
	return {
		child,
		emitStdout: (chunk) => {
			stdout.emit("data", chunk);
		},
		emitStderr: (chunk) => {
			stderr.emit("data", chunk);
		},
		emitExit: (code, signal) => {
			events.emit("exit", code, signal);
		},
		emitError: (error) => {
			events.emit("error", error);
		},
		kills,
	};
}

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
		fake.emitStdout("Web: http://127.0.0.1:4310/\n");
		await expect(pending).resolves.toBe("http://127.0.0.1:4310/");
		expect(logged.join("")).toContain("Web: http://127.0.0.1:4310/");
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
		fake.emitStdout("Web: http://127.0.0.1:1/\n");
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
		fake.emitStdout("Web: http://127.0.0.1:9/");
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
			fake.emitStdout("Web: http://127.0.0.1:1/\n");
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
		const supervisor = createHostSupervisor({ spawnHost: () => fake.child });
		const pending = supervisor.start();
		const assertion = expect(pending).rejects.toThrow(/failed to spawn: missing/);
		fake.emitError(new Error("missing"));
		await assertion;
	});

	test("reads a real process's launch line and stops it", async () => {
		const supervisor = createHostSupervisor({
			spawnHost: () =>
				spawnNodeChild({
					executable: process.execPath,
					args: [
						"-e",
						"process.stdout.write('noise\\nWeb: http://127.0.0.1:4310/\\n'); setInterval(() => {}, 1000);",
					],
					cwd: process.cwd(),
					env: process.env,
				}),
		});
		await expect(supervisor.start()).resolves.toBe("http://127.0.0.1:4310/");
		await supervisor.shutdown();
	});
});
