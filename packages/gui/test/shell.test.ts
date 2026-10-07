import { describe, expect, test } from "vitest";
import type { HostFailure, RenderFailure } from "../src/dialogs.ts";
import { createHostSupervisor } from "../src/host.ts";
import { createShellController } from "../src/shell.ts";
import { fakeHost } from "./fake-host.ts";

function recordingController() {
	const hosts: HostFailure[] = [];
	const renders: RenderFailure[] = [];
	const shell = createShellController({
		presentHostFailure(failure) {
			hosts.push(failure);
		},
		presentRenderFailure(failure) {
			renders.push(failure);
		},
	});
	return { shell, hosts, renders };
}

describe("quitting flag", () => {
	test("closing the window does not dialog for the host exit or the renderer teardown that follows", async () => {
		const { shell, hosts, renders } = recordingController();
		const fake = fakeHost();
		const supervisor = createHostSupervisor({
			spawnHost: () => fake.child,
			onUnexpectedExit: (detail) => {
				shell.hostExited(detail);
			},
		});
		const pending = supervisor.start();
		fake.emitStdout("Web: http://127.0.0.1:1/\n");
		await pending;
		shell.userClosedWindow();
		shell.renderProcessGone({ reason: "killed", exitCode: 0 });
		fake.emitExit(null, "SIGTERM");
		expect(shell.quitting).toBe(true);
		expect(hosts).toEqual([]);
		expect(renders).toEqual([]);
	});

	test("a normal application quit does not dialog for the host exit it causes", async () => {
		const { shell, hosts, renders } = recordingController();
		const fake = fakeHost();
		const supervisor = createHostSupervisor({
			spawnHost: () => fake.child,
			onUnexpectedExit: (detail) => {
				shell.hostExited(detail);
			},
		});
		const pending = supervisor.start();
		fake.emitStdout("Web: http://127.0.0.1:9/\n");
		await pending;
		shell.applicationWillQuit();
		fake.emitExit(0, null);
		shell.didFailLoad({
			isMainFrame: true,
			errorCode: -105,
			errorDescription: "ERR_NAME_NOT_RESOLVED",
			validatedURL: "http://127.0.0.1:9/",
		});
		expect(shell.quitting).toBe(true);
		expect(hosts).toEqual([]);
		expect(renders).toEqual([]);
	});

	test("a startup failure during close or quit is not a dialog", () => {
		const closed = recordingController();
		closed.shell.userClosedWindow();
		closed.shell.startupFailed({ kind: "spawn-error", message: "desktop host failed to spawn: missing", tail: "" });
		expect(closed.hosts).toEqual([]);

		const quit = recordingController();
		quit.shell.applicationWillQuit();
		quit.shell.startupFailed({
			kind: "exit-before-ready",
			message: "desktop host exited before readiness (code 1, signal null)",
			code: 1,
			signal: null,
			tail: "Error: boom\n",
		});
		expect(quit.hosts).toEqual([]);
	});

	test("an unexpected exit while the app is running is presented once, with the tail", async () => {
		const { shell, hosts } = recordingController();
		const fake = fakeHost();
		const supervisor = createHostSupervisor({
			spawnHost: () => fake.child,
			onUnexpectedExit: (detail) => {
				shell.hostExited(detail);
			},
		});
		const pending = supervisor.start();
		fake.emitStdout("Web: http://127.0.0.1:1/\n");
		await pending;
		fake.emitStderr("boom\n");
		fake.emitExit(1, null);
		fake.emitExit(1, null);
		expect(hosts).toEqual([
			{ kind: "unexpected-exit", code: 1, signal: null, tail: "Web: http://127.0.0.1:1/\nboom\n" },
		]);
	});

	test("ignores a subframe load and an aborted load, and presents a renderer crash and a real main-frame failure", () => {
		const { shell, renders } = recordingController();
		shell.didFailLoad({
			isMainFrame: false,
			errorCode: -105,
			errorDescription: "ERR_FAILED",
			validatedURL: "http://127.0.0.1:1/frame",
		});
		shell.didFailLoad({
			isMainFrame: true,
			errorCode: -3,
			errorDescription: "ERR_ABORTED",
			validatedURL: "http://127.0.0.1:1/",
		});
		shell.renderProcessGone({ reason: "oom", exitCode: 2 });
		shell.didFailLoad({
			isMainFrame: true,
			errorCode: -105,
			errorDescription: "ERR_NAME_NOT_RESOLVED",
			validatedURL: "http://127.0.0.1:1/",
		});
		expect(renders).toEqual([
			{ kind: "render-process-gone", reason: "oom", exitCode: 2 },
			{
				kind: "did-fail-load",
				isMainFrame: true,
				errorCode: -105,
				errorDescription: "ERR_NAME_NOT_RESOLVED",
				validatedURL: "http://127.0.0.1:1/",
			},
		]);
	});
});
