import { describe, expect, test } from "vitest";
import type { HostFailure, RenderFailure } from "../src/dialogs.ts";
import { createHostSupervisor } from "../src/host.ts";
import { createShellController } from "../src/shell.ts";
import { fakeHost, pythonReadyLine } from "./fake-host.ts";

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
		fake.emitStdout(`${pythonReadyLine(9)}\n`);
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

	test("a startup failure during quit is not a dialog", () => {
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
		fake.emitStdout(`${pythonReadyLine(1)}\n`);
		await pending;
		fake.emitStderr("boom\n");
		fake.emitExit(1, null);
		fake.emitExit(1, null);
		expect(hosts).toEqual([
			{ kind: "unexpected-exit", code: 1, signal: null, tail: `${pythonReadyLine(1)}\nboom\n` },
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
