import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createHostSupervisor } from "../src/host.ts";
import { createReadinessParser } from "../src/readiness.ts";
import { fakeHost } from "./fake-host.ts";
import {
	desktopPythonBootPlan,
	pairingCookie,
	parsePythonReadyLine,
	parsePythonUpdateRecord,
	pythonCompleteUpdateRequest,
	pythonPrepareUpdateRequest,
	pythonUpdateAction,
	pythonUpdateStatePath,
	readPythonBuildId,
	pythonResumeUpdateRequest,
	pythonShutdownRequest,
	readControlToken,
	requirePythonBackend,
	resolvePythonBackend,
	shouldStopSharedBackend,
	windowCloseAction,
	type PythonReady,
} from "../src/python-backend.ts";
import { createTempDir } from "./temp-dir.ts";

const BUILD = "ab".repeat(32);
const CONTROL = "cd".repeat(32);
const WEB = "ef".repeat(24);

function readyLine(): string {
	return JSON.stringify({
		url: "http://127.0.0.1:4310",
		version: "0.1.0",
		protocol: "amazme-http/1",
		build_id: BUILD,
		profile_id: "profile",
		instance_id: "host",
		pid: 7,
		host_epoch: 3,
		role: "host",
		state: "ready",
		storage_format: 2,
	});
}

function ready(): PythonReady {
	const parsed = parsePythonReadyLine(readyLine());
	if (parsed === undefined) throw new Error("fixture");
	return parsed;
}

describe("packaged python backend", () => {
	test("the desktop supervisor accepts the python readiness line", async () => {
		const fake = fakeHost();
		const supervisor = createHostSupervisor({ spawnHost: () => fake.child });
		const pending = supervisor.start();
		fake.emitStdout(`${readyLine()}\n`);
		await expect(pending).resolves.toBe("http://127.0.0.1:4310/");
		expect(supervisor.pythonReady()?.buildId).toBe(BUILD);
		expect(supervisor.pythonReady()?.hostEpoch).toBe(3);
		const stopped = supervisor.shutdown();
		fake.emitExit(null, "SIGTERM");
		await stopped;
	});

	test("reads the serve identity and ignores other output", () => {
		const parser = createReadinessParser();
		expect(parser.push("booting\n")).toBeUndefined();
		expect(parser.push(`${readyLine()}\n`)).toBe("http://127.0.0.1:4310/");
		expect(parser.pythonReady()).toEqual({
			pageUrl: "http://127.0.0.1:4310/",
			origin: "http://127.0.0.1:4310",
			buildId: BUILD,
			hostEpoch: 3,
			profileId: "profile",
		});
		expect(parsePythonReadyLine("Web: http://127.0.0.1:4310/")).toBeUndefined();
	});

	test("rejects a readiness line that is not this host", () => {
		expect(() => parsePythonReadyLine(JSON.stringify({ url: "http://10.0.0.1:1/", build_id: BUILD, host_epoch: 1, role: "host", protocol: "amazme-http/1", profile_id: "p" }))).toThrow(/loopback/);
		expect(() => parsePythonReadyLine(JSON.stringify({ url: "http://127.0.0.1:4310/", build_id: "short", host_epoch: 1, role: "host", protocol: "amazme-http/1", profile_id: "p" }))).toThrow(/build_id/);
	});

	test("plans init, pair, and serve without node or the tokens", () => {
		const plan = desktopPythonBootPlan({
			executable: "/Apps/amazme-backend",
			profile: "/Profiles/main",
			workspace: "/Work",
			providerConfig: "/Profiles/faux-provider.json",
			profileExists: false,
			cwd: "/Work",
			env: { ELECTRON_RUN_AS_NODE: "1", AMAZME_PYTHON_BACKEND: "/Apps/amazme-backend", PATH: "/usr/bin" },
		});
		expect(plan.preflight.map((step) => step.command)).toEqual(["init", "pair"]);
		expect(plan.preflight[0]?.args).toEqual(["init", "--profile", "/Profiles/main", "--workspace", "/Work", "--provider-config", "/Profiles/faux-provider.json"]);
		expect(plan.preflight[1]?.args).toEqual(["pair", "--profile", "/Profiles/main"]);
		expect(plan.serveArgs).toEqual(["serve", "--profile", "/Profiles/main", "--port", "0"]);
		expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(plan.env.AMAZME_PYTHON_BACKEND).toBeUndefined();
		expect(plan.env.PATH).toBe("/usr/bin");
		expect(JSON.stringify(plan)).not.toContain(CONTROL);
		const again = desktopPythonBootPlan({ ...{
			executable: plan.executable, profile: "/Profiles/main", workspace: "/Work", providerConfig: "/Profiles/faux-provider.json", cwd: "/Work", env: {},
		}, profileExists: true });
		expect(again.preflight.map((step) => step.command)).toEqual(["pair"]);
	});

	test("closes a window without stopping, and explicit quit uses the control token", () => {
		expect(shouldStopSharedBackend("window-closed")).toBe(false);
		expect(shouldStopSharedBackend("explicit-quit")).toBe(true);
		expect(windowCloseAction({ quitting: false, pythonBackend: true, tray: true })).toBe("hide");
		expect(windowCloseAction({ quitting: false, pythonBackend: true, tray: false })).toBe("allow");
		expect(windowCloseAction({ quitting: false, pythonBackend: false, tray: false })).toBe("quit");
		expect(windowCloseAction({ quitting: true, pythonBackend: true, tray: true })).toBe("allow");
		const request = pythonShutdownRequest(ready(), CONTROL, WEB);
		expect(request.url).toBe("http://127.0.0.1:4310/control/shutdown");
		expect(request.headers.Authorization).toBe(`Bearer ${CONTROL}`);
		expect(request.body).toBe(JSON.stringify({ host_epoch: 3, build_id: BUILD }));
		expect(request.timeoutMs).toBeGreaterThanOrEqual(60_000);
		expect(request.body).not.toContain(WEB);
		expect(() => pythonShutdownRequest(ready(), WEB, WEB)).toThrow(/control token/);
	});

	test("prepares and resumes an update on the control API", () => {
		const prepare = pythonPrepareUpdateRequest(ready(), CONTROL, WEB, "replace-1", BUILD);
		expect(prepare.url).toBe("http://127.0.0.1:4310/control/updates/prepare");
		expect(JSON.parse(prepare.body)).toEqual({ update_id: "replace-1", target_build: BUILD, cancel_work: false });
		expect(prepare.headers.Authorization).not.toContain(WEB);
		expect(() => pythonPrepareUpdateRequest(ready(), CONTROL, WEB, "replace-1", "nope")).toThrow(/target build/);
		const resume = pythonResumeUpdateRequest(ready(), CONTROL, WEB, "replace-1");
		expect(resume.url).toBe("http://127.0.0.1:4310/control/updates/replace-1/resume");
		expect(resume.body).toBe("");
		expect(resume.headers.Authorization).toBe(`Bearer ${CONTROL}`);
		const complete = pythonCompleteUpdateRequest(ready(), CONTROL, WEB, "replace-1", "4");
		expect(complete.url).toBe("http://127.0.0.1:4310/control/updates/complete");
		expect(JSON.parse(complete.body)).toEqual({ update_id: "replace-1", expected_revision: "4" });
		expect(complete.headers.Authorization).not.toContain(WEB);
	});

	test("keeps a source build frozen and activates only the target build", () => {
		const source = "a".repeat(64);
		const target = "b".repeat(64);
		const prepared = { source_build: source, target_build: target, activated: false, phase: "prepared" };
		expect(pythonUpdateAction(source, prepared)).toBe("hold");
		expect(pythonUpdateAction(target, prepared)).toBe("verify");
		expect(pythonUpdateAction(target, { ...prepared, phase: "validating" })).toBe("activate");
		expect(pythonUpdateAction(target, { ...prepared, activated: true, phase: "completed" })).toBe("hold");
		const parsed = parsePythonUpdateRecord({
			update_id: "replace-1", source_build: source, target_build: target, phase: "validating", revision: "4",
			activated: false, validation: { purpose: "validation" },
		});
		expect(parsed?.validationPurpose).toBe("validation");
		expect(parsed === undefined ? "hold" : pythonUpdateAction(target, {
			source_build: parsed.sourceBuild, target_build: parsed.targetBuild, activated: parsed.activated, phase: parsed.phase,
		})).toBe("activate");
	});

	test("reads the staged python build id", () => {
		const dir = createTempDir("amazme-python-build-");
		expect(readPythonBuildId(dir)).toBeUndefined();
		mkdirSync(join(dir, "amazme-backend"));
		writeFileSync(join(dir, "amazme-backend", "build.json"), JSON.stringify({ build_id: BUILD }));
		expect(readPythonBuildId(dir)).toBe(BUILD);
		expect(pythonUpdateStatePath(dir)).toBe(join(dir, "updates", "python-update.json"));
	});

	test("pairs with a cookie and does not put the token in the URL", () => {
		const cookie = pairingCookie("http://127.0.0.1:4310/", WEB);
		expect(cookie).toEqual({ url: "http://127.0.0.1:4310", name: "amazme", value: WEB, httpOnly: true, secure: false, sameSite: "lax", path: "/" });
		expect(cookie.url).not.toContain(WEB);
	});

	test("reads the control token from the profile and prefers the packaged binary", () => {
		const dir = createTempDir("amazme-python-");
		mkdirSync(join(dir, "resources", "amazme-backend"), { recursive: true });
		mkdirSync(join(dir, "profile"), { recursive: true });
		writeFileSync(join(dir, "resources", "amazme-backend", "amazme-backend"), "");
		writeFileSync(join(dir, "profile", "control.token"), `${CONTROL}\n`);
		expect(readControlToken(join(dir, "profile"))).toBe(CONTROL);
		expect(resolvePythonBackend({}, join(dir, "resources"))).toBe(join(dir, "resources", "amazme-backend", "amazme-backend"));
		expect(resolvePythonBackend({ AMAZME_PYTHON_BACKEND: "/explicit/amazme-backend" }, join(dir, "resources"))).toBe("/explicit/amazme-backend");
		expect(resolvePythonBackend({}, undefined)).toBeUndefined();
		expect(requirePythonBackend(resolvePythonBackend({}, join(dir, "resources")))).toBe(join(dir, "resources", "amazme-backend", "amazme-backend"));
		expect(() => requirePythonBackend(resolvePythonBackend({}, undefined))).toThrow("桌面需要包内的 Python 后端");
	});
});
