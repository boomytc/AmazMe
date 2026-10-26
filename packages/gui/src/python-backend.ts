import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BUILD_ID = /^[a-f0-9]{64}$/u;
const CONTROL_TOKEN = /^[0-9a-f]{64}$/u;

/** Identity the packaged backend prints once, before it accepts product calls. */
export interface PythonReady {
	readonly pageUrl: string;
	readonly origin: string;
	readonly buildId: string;
	readonly hostEpoch: number;
	readonly profileId: string;
}

export interface PythonCommand {
	readonly command: "init" | "pair" | "serve";
	readonly args: readonly string[];
}

export interface PythonDesktopPlan {
	readonly executable: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly entries: readonly string[];
	/** Short commands that finish before the supervised server starts. */
	readonly preflight: readonly PythonCommand[];
	readonly serveArgs: readonly string[];
}

/** Packaged onedir, or the explicit path a developer pointed at. Never a system `python`. */
export function resolvePythonBackend(env: NodeJS.ProcessEnv, resourcesPath: string | undefined): string | undefined {
	const override = env.AMAZME_PYTHON_BACKEND;
	if (override !== undefined && override.length > 0) return override;
	if (resourcesPath === undefined || resourcesPath.length === 0) return undefined;
	const packaged = join(resourcesPath, "amazme-backend", "amazme-backend");
	return existsSync(packaged) ? packaged : undefined;
}

/** The desktop has no other host. A missing backend is a startup failure, not a fallback. */
export function requirePythonBackend(executable: string | undefined): string {
	if (executable === undefined || executable.length === 0) {
		throw new Error("桌面需要包内的 Python 后端");
	}
	return executable;
}

export function shouldStopSharedBackend(reason: "window-closed" | "explicit-quit"): boolean {
	return reason === "explicit-quit";
}

/** Closing a window must not stop a shared Python backend. A tray only hides that window. */
export function windowCloseAction(input: { readonly quitting: boolean; readonly pythonBackend: boolean; readonly tray: boolean }): "allow" | "hide" | "quit" {
	if (input.quitting) return "allow";
	if (input.pythonBackend && !shouldStopSharedBackend("window-closed")) return input.tray ? "hide" : "allow";
	return input.tray ? "hide" : "quit";
}

/** One stdout line from `amazme-backend serve`. Other lines are ignored. */
export function parsePythonReadyLine(line: string): PythonReady | undefined {
	const trimmed = line.replace(/\r$/u, "").trim();
	if (!trimmed.startsWith("{")) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		throw new Error("desktop python backend emitted invalid readiness JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("desktop python backend readiness must be an object");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.url !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(record.url);
	} catch {
		throw new Error(`desktop python backend launch URL is invalid: ${record.url}`);
	}
	const port = Number(url.port);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535
	) {
		throw new Error(`desktop python backend launch URL must be loopback HTTP: ${record.url}`);
	}
	if (typeof record.build_id !== "string" || !BUILD_ID.test(record.build_id)) {
		throw new Error("desktop python backend readiness is missing build_id");
	}
	if (typeof record.host_epoch !== "number" || !Number.isInteger(record.host_epoch) || record.host_epoch < 0) {
		throw new Error("desktop python backend readiness is missing host_epoch");
	}
	if (record.role !== "host" || record.protocol !== "amazme-http/1") {
		throw new Error("desktop python backend readiness is not the product host");
	}
	if (typeof record.profile_id !== "string" || record.profile_id.length === 0) {
		throw new Error("desktop python backend readiness is missing profile_id");
	}
	return {
		pageUrl: url.href,
		origin: `${url.protocol}//${url.host}`,
		buildId: record.build_id,
		hostEpoch: record.host_epoch,
		profileId: record.profile_id,
	};
}

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const copy: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || key.startsWith("ELECTRON_") || key === "AMAZME_PYTHON_BACKEND") continue;
		copy[key] = value;
	}
	return copy;
}

function distinctTokens(controlToken: string, webToken: string): void {
	if (!CONTROL_TOKEN.test(controlToken) || controlToken === webToken) {
		throw new Error("desktop control token must be the profile control token");
	}
}

export function desktopPythonBootPlan(input: {
	readonly executable: string;
	readonly profile: string;
	readonly workspace: string;
	readonly providerConfig: string;
	readonly profileExists: boolean;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}): PythonDesktopPlan {
	const preflight: PythonCommand[] = [];
	if (!input.profileExists) {
		preflight.push({
			command: "init",
			args: ["init", "--profile", input.profile, "--workspace", input.workspace, "--provider-config", input.providerConfig],
		});
	}
	preflight.push({ command: "pair", args: ["pair", "--profile", input.profile] });
	return {
		executable: input.executable,
		cwd: input.cwd,
		env: childEnv(input.env),
		entries: [input.executable],
		preflight,
		serveArgs: ["serve", "--profile", input.profile, "--port", "0"],
	};
}

export function readControlToken(profile: string): string {
	const token = readFileSync(join(profile, "control.token"), "utf8").trim();
	if (!CONTROL_TOKEN.test(token)) throw new Error("desktop control token is missing");
	return token;
}

/** Covers the host's 30s supervisor-exit wait and the shutdown request that precedes it. */
export const PYTHON_SHUTDOWN_TIMEOUT_MS = 60_000;

export function pythonShutdownRequest(ready: PythonReady, controlToken: string, webToken: string): {
	readonly url: string;
	readonly headers: { readonly Authorization: string; readonly "content-type": "application/json" };
	readonly body: string;
	readonly timeoutMs: number;
} {
	distinctTokens(controlToken, webToken);
	return {
		url: `${ready.origin}/control/shutdown`,
		headers: { Authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
		body: JSON.stringify({ host_epoch: ready.hostEpoch, build_id: ready.buildId }),
		timeoutMs: PYTHON_SHUTDOWN_TIMEOUT_MS,
	};
}

export function pythonPrepareUpdateRequest(
	ready: PythonReady,
	controlToken: string,
	webToken: string,
	updateId: string,
	targetBuild: string,
): {
	readonly url: string;
	readonly headers: { readonly Authorization: string; readonly "content-type": "application/json" };
	readonly body: string;
} {
	distinctTokens(controlToken, webToken);
	if (updateId.length === 0 || !BUILD_ID.test(targetBuild)) {
		throw new Error("desktop update prepare needs an id and the target build");
	}
	return {
		url: `${ready.origin}/control/updates/prepare`,
		headers: { Authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
		body: JSON.stringify({ update_id: updateId, target_build: targetBuild, cancel_work: false }),
	};
}

export function pythonCompleteUpdateRequest(
	ready: PythonReady,
	controlToken: string,
	webToken: string,
	updateId: string,
	expectedRevision: string,
): {
	readonly url: string;
	readonly headers: { readonly Authorization: string; readonly "content-type": "application/json" };
	readonly body: string;
} {
	distinctTokens(controlToken, webToken);
	if (!/^[A-Za-z0-9._-]{1,128}$/u.test(updateId) || expectedRevision.length === 0) {
		throw new Error("desktop update activate needs the prepared id and revision");
	}
	return {
		url: `${ready.origin}/control/updates/complete`,
		headers: { Authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
		body: JSON.stringify({ update_id: updateId, expected_revision: expectedRevision }),
	};
}

export interface PythonUpdateRecord {
	readonly updateId: string;
	readonly sourceBuild: string;
	readonly targetBuild: string;
	readonly phase: string;
	readonly revision: string;
	readonly activated: boolean;
	readonly validationPurpose: string;
}

export function parsePythonUpdateRecord(value: unknown): PythonUpdateRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.update_id !== "string" || typeof record.source_build !== "string" || typeof record.target_build !== "string") return undefined;
	if (typeof record.phase !== "string" || typeof record.revision !== "string" || typeof record.activated !== "boolean") return undefined;
	const validation = record.validation;
	const purpose = typeof validation === "object" && validation !== null && typeof (validation as { readonly purpose?: unknown }).purpose === "string"
		? (validation as { readonly purpose: string }).purpose
		: "";
	return {
		updateId: record.update_id,
		sourceBuild: record.source_build,
		targetBuild: record.target_build,
		phase: record.phase,
		revision: record.revision,
		activated: record.activated,
		validationPurpose: purpose,
	};
}

/** Running the old build must not activate. Only the target build verifies, then activates. */
export function pythonUpdateAction(runningBuild: string, record: {
	readonly source_build: string;
	readonly target_build: string;
	readonly activated: boolean;
	readonly phase: string;
}): "hold" | "verify" | "activate" {
	if (record.activated || runningBuild !== record.target_build) return "hold";
	if (record.phase === "validating" || record.phase === "completed") return "activate";
	return "verify";
}

/** The Host owns update admission, including replacements made outside the installer. */
export async function settlePythonBackendUpdate(ready: PythonReady, controlToken: string, webToken: string): Promise<PythonUpdateRecord | undefined> {
	distinctTokens(controlToken, webToken);
	async function call(path: string, method: "GET" | "POST", body?: string): Promise<unknown> {
		const response = await fetch(`${ready.origin}${path}`, {
			method, redirect: "error", signal: AbortSignal.timeout(120_000),
			headers: { Authorization: `Bearer ${path.startsWith("/control/") ? controlToken : webToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body }),
		});
		if (!response.ok) {
			const failure: unknown = await response.json().catch(() => undefined);
			const code = typeof failure === "object" && failure !== null && "code" in failure
				&& typeof failure.code === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(failure.code) ? failure.code : "";
			throw new Error(`后端更新核对失败（${response.status}${code ? `，${code}` : ""}），已保留冻结状态。`);
		}
		return response.json();
	}
	const health = await call("/api/v1/health", "GET");
	if (typeof health !== "object" || health === null || !("identity" in health)) throw new Error("后端更新状态无效");
	const identity = health.identity;
	if (typeof identity !== "object" || identity === null || !("profile_id" in identity) || identity.profile_id !== ready.profileId
		|| !("build_id" in identity) || identity.build_id !== ready.buildId || !("host_epoch" in identity) || identity.host_epoch !== ready.hostEpoch) throw new Error("后端更新身份不匹配");
	if (!("update" in health)) throw new Error("后端更新记录缺失");
	if (health.update === null) return undefined;
	let record = parsePythonUpdateRecord(health.update);
	if (!record) throw new Error("后端更新记录无效");
	const action = pythonUpdateAction(ready.buildId, { source_build: record.sourceBuild, target_build: record.targetBuild, activated: record.activated, phase: record.phase });
	if (action === "hold") throw new Error("后端已冻结，请启动该更新的目标构建。");
	if (action === "verify") {
		const request = pythonResumeUpdateRequest(ready, controlToken, webToken, record.updateId);
		const resumed = parsePythonUpdateRecord(await call(new URL(request.url).pathname, "POST"));
		if (!resumed || resumed.updateId !== record.updateId || resumed.targetBuild !== ready.buildId) throw new Error("后端更新核对回执不匹配");
		record = resumed;
	}
	if (record.activated) return record;
	if (record.phase !== "validating" && record.phase !== "completed") throw new Error("后端更新核对尚未完成，已保留冻结状态。");
	const request = pythonCompleteUpdateRequest(ready, controlToken, webToken, record.updateId, record.revision);
	const activated = parsePythonUpdateRecord(await call(new URL(request.url).pathname, "POST", request.body));
	if (!activated?.activated || activated.updateId !== record.updateId || activated.targetBuild !== ready.buildId) throw new Error("后端更新尚未激活，已保留原更新记录。");
	return activated;
}

export function pythonUpdateStatePath(userData: string): string {
	return join(userData, "updates", "python-update.json");
}

/** The staged app or onedir names the build the running host must become before it can thaw. */
export function readPythonBuildId(root: string): string | undefined {
	const candidates = [
		join(root, "build.json"),
		join(root, "amazme-backend", "build.json"),
		join(root, "AmazMe.app", "Contents", "Resources", "amazme-backend", "build.json"),
		join(root, "Contents", "Resources", "amazme-backend", "build.json"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed !== "object" || parsed === null) continue;
			const buildId = (parsed as { readonly build_id?: unknown }).build_id;
			if (typeof buildId === "string" && BUILD_ID.test(buildId)) return buildId;
		} catch {
			continue;
		}
	}
	return undefined;
}

export function pythonResumeUpdateRequest(ready: PythonReady, controlToken: string, webToken: string, updateId: string): {
	readonly url: string;
	readonly headers: { readonly Authorization: string };
	readonly body: "";
} {
	distinctTokens(controlToken, webToken);
	if (!/^[A-Za-z0-9._-]{1,128}$/u.test(updateId)) throw new Error("desktop update resume needs the prepared id");
	return {
		url: `${ready.origin}/control/updates/${updateId}/resume`,
		headers: { Authorization: `Bearer ${controlToken}` },
		body: "",
	};
}

/** Python supplies model defaults; only an explicit smoke run selects its fixture. */
export function initialPythonProvider(smoke: boolean): {provider:"deepseek" | "faux"; model?:string; base_url?:string} {
    return smoke ? {provider:"faux", model:"faux", base_url:""} : {provider:"deepseek"};
}
