import { readFileSync } from "node:fs";
import { join } from "node:path";

const BUILD_ID = /^[a-f0-9]{64}$/u;
const CONTROL_TOKEN = /^[0-9a-f]{64}$/u;

/** Authenticated identity returned by the local Python connector. */
export interface PythonReady {
	readonly pageUrl: string;
	readonly origin: string;
	readonly buildId: string;
	readonly hostEpoch: number;
	readonly profileId: string;
}

/** The desktop has no other host. A missing backend is a startup failure, not a fallback. */
export function requirePythonBackend(executable: string | undefined): string {
	if (executable === undefined || executable.length === 0) {
		throw new Error("请通过 ./start.sh 启动桌面，以选择项目的 Python 后端");
	}
	return executable;
}

/** The local connector returns one JSON readiness record. */
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

export function readControlToken(profile: string): string {
	const token = readFileSync(join(profile, "control.token"), "utf8").trim();
	if (!CONTROL_TOKEN.test(token)) throw new Error("desktop control token is missing");
	return token;
}
