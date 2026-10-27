/**
 * Connect to an explicit host, or start the local persistent one. Temporary hosts
 * own their process; an existing local profile is reused and never deleted here.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { fail, isRecord } from "../client/host-client.ts";
import { getAgentDir } from "../config.ts";

function backendCommand(): string {
	return process.env.AMAZME_PYTHON_BACKEND || "amazme-backend";
}

async function liveUrl(readyPath: string, tokenPath: string): Promise<string> {
	if (!existsSync(readyPath) || !existsSync(tokenPath)) return "";
	try {
		const ready = JSON.parse(readFileSync(readyPath, "utf8")) as unknown;
		if (!isRecord(ready) || typeof ready.url !== "string") return "";
		const token = readFileSync(tokenPath, "utf8").trim();
		const response = await fetch(`${ready.url}/api/v1/bootstrap`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(2000),
		});
		return response.ok ? ready.url : "";
	} catch {
		return "";
	}
}

function startServe(command: string, profile: string): Promise<string> {
	const err = openSync(join(profile, "serve.err"), "a");
	let child;
	try {
		child = spawn(command, ["serve", "--profile", profile, "--port", "0"], {
			detached: true,
			stdio: ["ignore", "pipe", err],
		});
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : "";
		fail(code === "ENOENT" ? "python_backend_missing" : "python_serve_failed");
	} finally {
		closeSync(err);
	}
	child.unref();
	const stdout = child.stdout;
	if (!stdout) fail("python_serve_failed");
	return new Promise((resolveReady, reject) => {
		let pending = "";
		let settled = false;
		const finish = (error: Error | undefined, url?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdout.off("data", onData);
			if (error) {
				child.kill();
				reject(error);
				return;
			}
			stdout.destroy();
			resolveReady(url ?? "");
		};
		const timer = setTimeout(() => finish(new Error("python_serve_timeout")), 30_000);
		const onData = (chunk: Buffer | string): void => {
			pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			const newline = pending.indexOf("\n");
			if (newline < 0) return;
			const line = pending.slice(0, newline);
			let ready: unknown;
			try {
				ready = JSON.parse(line);
			} catch {
				finish(new Error("python_serve_failed"));
				return;
			}
			if (!isRecord(ready) || typeof ready.url !== "string") {
				finish(new Error("python_serve_failed"));
				return;
			}
			finish(undefined, ready.url);
		};
		stdout.on("data", onData);
		child.once("error", (error: NodeJS.ErrnoException) => {
			finish(new Error(error.code === "ENOENT" ? "python_backend_missing" : "python_serve_failed"));
		});
		child.once("exit", () => finish(new Error("python_serve_failed")));
	});
}

function ensurePythonProfile(cwd: string, sessionDir?: string): string {
	if (sessionDir && resolve(cwd,sessionDir) === resolve(getAgentDir())) return ensurePythonProfile(cwd);
	const command = backendCommand();
	const profile = join(sessionDir ? resolve(cwd, sessionDir) : getAgentDir(), "python-host");
	if (!existsSync(join(profile, "config.json"))) {
		if (sessionDir) {
			const source = ensurePythonProfile(cwd);
			const init = spawnSync(command, ["init", "--profile", profile, "--workspace", resolve(cwd),
				"--source-profile", source], {encoding:"utf8"});
			if (init.error || init.status !== 0) fail("python_init_failed");
			return profile;
		}
		mkdirSync(getAgentDir(), { recursive: true });
		const staging = mkdtempSync(join(getAgentDir(), ".python-init-"));
		const providerPath = join(staging, "provider.json");
		try {
			writeFileSync(
				providerPath,
				JSON.stringify({
					provider: "faux",
					model: "faux",
					base_url: "",
					api_key: "",
					max_tokens: 2048,
					proxy: "",
					headers: {},
				}),
				{ mode: 0o600 },
			);
			const init = spawnSync(
				command,
				["init", "--profile", profile, "--workspace", resolve(cwd), "--provider-config", providerPath],
				{ encoding: "utf8" },
			);
			const errno = init.error as NodeJS.ErrnoException | null;
			if (errno?.code === "ENOENT") fail("python_backend_missing");
			if (init.status !== 0) fail("python_init_failed");
		} finally {
			rmSync(staging, {recursive:true, force:true});
		}
	}
	return profile;
}

export interface PythonHostConnection {
	readonly url:string;
	readonly token:string;
	readonly close?: () => Promise<void>;
}

async function transientHost(cwd:string, workspace?:string): Promise<PythonHostConnection> {
	const source = ensurePythonProfile(cwd);
	const child = spawn(backendCommand(), ["transient", "--source-profile", source, "--workspace", resolve(cwd),
		...(workspace ? ["--workspace-name",workspace] : [])], {stdio:["pipe","pipe","inherit"],detached:true});
	const ending = new Promise<number>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("exit", code => resolveExit(code ?? 1));
	});
	// Attach a rejection handler immediately, including during the readiness handshake.
	void ending.catch(() => {});
	const close = async (): Promise<void> => {
		child.stdin.end();
		if (await ending) throw new Error("transient_recovery_retained");
	};
	try {
		const ready = await new Promise<{url:string;token:string}>((resolveReady,rejectReady) => {
			let pending = "", settled = false;
			const finish = (error?:Error, value?:{url:string;token:string}): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.stdout.off("data", onData);
				if (error) rejectReady(error);
				else if (value) resolveReady(value);
			};
			const onData = (chunk:Buffer): void => {
				pending += chunk.toString("utf8");
				if (pending.length > 65536) return finish(new Error("invalid_transient_host"));
				const newline = pending.indexOf("\n");
				if (newline < 0) return;
				try {
					const value:unknown = JSON.parse(pending.slice(0,newline));
					if (!isRecord(value) || typeof value.url !== "string" || typeof value.token !== "string")
						throw new Error("invalid_transient_host");
					finish(undefined,{url:value.url,token:value.token});
				} catch { finish(new Error("invalid_transient_host")); }
			};
			const timer = setTimeout(() => finish(new Error("transient_host_timeout")), 45000);
			child.stdout.on("data",onData);
			void ending.then(() => finish(new Error("transient_host_exited")), error => finish(error instanceof Error ? error : new Error("python_backend_missing")));
		});
		return {...ready, close};
	} catch(error) {
		await close().catch(() => {});
		throw error;
	}
}

/** Attach to an explicit host, or start the local one without deleting an existing profile. */
export async function connectPythonHost(options: {
	readonly cwd: string;
	readonly url?: string;
	readonly token?: string;
	readonly noSession?: boolean;
	readonly workspace?: string;
	readonly sessionDir?: string;
}): Promise<PythonHostConnection> {
	if ((options.url === undefined) !== (options.token === undefined)) fail("python_target_required");
	if (options.sessionDir && (options.url || options.noSession)) fail("session_dir_requires_local_persistent_host");
	if (options.noSession) {
		if (options.url || options.token) fail("no_session_requires_local_host");
		return transientHost(options.cwd, options.workspace);
	}
	if (options.url && options.token) return { url: options.url, token: options.token };
	const command = backendCommand();
	const profile = ensurePythonProfile(options.cwd, options.sessionDir);
	const tokenPath = join(profile, "web.token");
	const readyPath = join(profile, "ready.json");
	const existing = await liveUrl(readyPath, tokenPath);
	const url = existing || (await startServe(command, profile));
	return { url, token: readFileSync(tokenPath, "utf8").trim() };
}
