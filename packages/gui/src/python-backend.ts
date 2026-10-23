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

export function shouldStopSharedBackend(reason: "window-closed" | "explicit-quit"): boolean {
	return reason === "explicit-quit";
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

export function pairingCookie(pageUrl: string, webToken: string): {
	readonly url: string;
	readonly name: "amazme";
	readonly value: string;
	readonly httpOnly: true;
	readonly sameSite: "strict";
	readonly path: "/";
} {
	const url = new URL(pageUrl);
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
		throw new Error("desktop pairing cookie URL must not carry the token");
	}
	if (webToken.length === 0 || url.href.includes(webToken)) {
		throw new Error("desktop pairing token must stay out of the page URL");
	}
	return { url: url.origin, name: "amazme", value: webToken, httpOnly: true, sameSite: "strict", path: "/" };
}

export function readControlToken(profile: string): string {
	const token = readFileSync(join(profile, "control.token"), "utf8").trim();
	if (!CONTROL_TOKEN.test(token)) throw new Error("desktop control token is missing");
	return token;
}

export function pythonShutdownRequest(ready: PythonReady, controlToken: string, webToken: string): {
	readonly url: string;
	readonly headers: { readonly Authorization: string; readonly "content-type": "application/json" };
	readonly body: string;
} {
	distinctTokens(controlToken, webToken);
	return {
		url: `${ready.origin}/control/shutdown`,
		headers: { Authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
		body: JSON.stringify({ host_epoch: ready.hostEpoch, build_id: ready.buildId }),
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
