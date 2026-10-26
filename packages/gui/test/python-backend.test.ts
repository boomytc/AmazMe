import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createHostSupervisor } from "../src/host.ts";
import { createReadinessParser } from "../src/readiness.ts";
import { fakeHost } from "./fake-host.ts";
import {
	desktopPythonBootPlan,
	initialPythonProvider,
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
	settlePythonBackendUpdate,
	type PythonReady,
} from "../src/python-backend.ts";
import { createTempDir } from "./temp-dir.ts";

const BUILD = "ab".repeat(32);
const CONTROL = "cd".repeat(32);
const WEB = "ef".repeat(24);
afterEach(() => vi.unstubAllGlobals());

function readyLine(): string {
	return JSON.stringify({
		url: "http://127.0.0.1:4310",
		version: "9.8.7",
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

	test("plans init only for a new profile and serve without a pairing subprocess or tokens", () => {
		const plan = desktopPythonBootPlan({
			executable: "/Apps/amazme-backend",
			profile: "/Profiles/main",
			workspace: "/Work",
			providerConfig: "/Profiles/faux-provider.json",
			profileExists: false,
			cwd: "/Work",
			env: { ELECTRON_RUN_AS_NODE: "1", AMAZME_PYTHON_BACKEND: "/Apps/amazme-backend", PATH: "/usr/bin" },
		});
		expect(plan.preflight.map((step) => step.command)).toEqual(["init"]);
		expect(plan.preflight[0]?.args).toEqual(["init", "--profile", "/Profiles/main", "--workspace", "/Work", "--provider-config", "/Profiles/faux-provider.json"]);
		expect(plan.serveArgs).toEqual(["serve", "--profile", "/Profiles/main", "--port", "0"]);
		expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(plan.env.AMAZME_PYTHON_BACKEND).toBeUndefined();
		expect(plan.env.PATH).toBe("/usr/bin");
		expect(JSON.stringify(plan)).not.toContain(CONTROL);
		const again = desktopPythonBootPlan({ ...{
			executable: plan.executable, profile: "/Profiles/main", workspace: "/Work", providerConfig: "/Profiles/faux-provider.json", cwd: "/Work", env: {},
		}, profileExists: true });
		expect(again.preflight).toEqual([]);
	});

	test("explicit quit uses the control token and the existing shutdown timeout", () => {
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

	test("settles a Host replacement without an installer sidecar, using the original update ID", async () => {
		const record = { update_id: "replace-local", source_build: "1".repeat(64), target_build: BUILD, phase: "freezing", revision: "2", activated: false };
		const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ identity: { profile_id: "profile", build_id: BUILD, host_epoch: 3 }, update: record }))
			.mockResolvedValueOnce(Response.json({ ...record, phase: "validating", revision: "7" }))
			.mockResolvedValueOnce(Response.json({ ...record, phase: "completed", revision: "9", activated: true }));
		vi.stubGlobal("fetch", fetcher);
		await expect(settlePythonBackendUpdate(ready(), CONTROL, WEB)).resolves.toMatchObject({ updateId: "replace-local", activated: true });
		expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/api/v1/health", "/control/updates/replace-local/resume", "/control/updates/complete"]);
		expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${WEB}`);
		expect(fetcher.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${CONTROL}`);
		expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ update_id: "replace-local", expected_revision: "7" });
	});

	test("ready startup does not submit an update and a failed verification never activates", async () => {
		const identity = { profile_id: "profile", build_id: BUILD, host_epoch: 3 };
		const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ identity, update: null }));
		vi.stubGlobal("fetch", fetcher);
		await expect(settlePythonBackendUpdate(ready(), CONTROL, WEB)).resolves.toBeUndefined();
		expect(fetcher).toHaveBeenCalledTimes(1);
		fetcher.mockReset().mockResolvedValueOnce(Response.json({ identity, update: { update_id: "replace-local", source_build: "1".repeat(64), target_build: BUILD, phase: "freezing", revision: "2", activated: false } }))
			.mockResolvedValueOnce(Response.json({ code: "execution_cleanup_pending" }, { status: 503 }));
		await expect(settlePythonBackendUpdate(ready(), CONTROL, WEB)).rejects.toThrow("503，execution_cleanup_pending");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	test("keeps the HTTP failure when the backend returns a non-JSON error", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
		await expect(settlePythonBackendUpdate(ready(), CONTROL, WEB)).rejects.toThrow("后端更新核对失败（503）");
	});

	test("another Host generation or a source build cannot thaw the update", async () => {
		const identity = { profile_id: "profile", build_id: BUILD, host_epoch: 3 };
		const record = { update_id: "replace-local", source_build: BUILD, target_build: "1".repeat(64), phase: "prepared", revision: "2", activated: false };
		const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ identity: { ...identity, host_epoch: 4 }, update: record }))
			.mockResolvedValueOnce(Response.json({ identity, update: record }));
		vi.stubGlobal("fetch", fetcher);
		await expect(settlePythonBackendUpdate(ready(), CONTROL, WEB)).rejects.toThrow("身份不匹配");
		await expect(settlePythonBackendUpdate(ready(), CONTROL, WEB)).rejects.toThrow("目标构建");
		expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
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

test("normal desktop startup uses Python provider defaults and fixtures require explicit smoke mode", () => {
    expect(initialPythonProvider(false)).toEqual({provider:"deepseek"});
    expect(initialPythonProvider(true)).toEqual({provider:"faux",model:"faux",base_url:""});
});
