/** Local lifecycle belongs to Python; persistent clients only attach. */
import { execFile, spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fail, isRecord } from "../client/host-client.ts";
import { getAgentDir } from "../config.ts";

const run = promisify(execFile);

function backendCommand(): string {
    return process.env.AMAZME_PYTHON_BACKEND || "amazme-backend";
}

export interface PythonHostConnection {
    readonly url: string;
    readonly token: string;
    readonly close?: () => Promise<void>;
}

async function localProfile(cwd: string, profile?: string, source?: string, noStart = true): Promise<{
    readonly profilePath: string; readonly url: string; readonly token: string;
}> {
    let output: string;
    try {
        const result = await run(backendCommand(), ["connect", "--workspace", resolve(cwd),
            ...(profile ? ["--profile", profile] : []), ...(source ? ["--source-profile", source] : []),
            ...(noStart ? ["--no-start"] : [])], { env: { ...process.env, AMAZME_NODE: process.env.AMAZME_NODE || process.execPath }, encoding: "utf8", timeout: 310_000, maxBuffer: 1_048_576 });
        output = result.stdout;
    } catch (error: unknown) {
        if (isRecord(error) && error.code === "ENOENT") fail("python_backend_missing");
        const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
        const code = /^\s*\{"code":\s*"([a-z][a-z0-9_]{0,127})"\}\s*$/u.exec(stderr)?.[1];
        fail(code ?? "python_connect_failed");
    }
    let value: unknown;
    try { value = JSON.parse(output); } catch { fail("invalid_local_host"); }
    if (!isRecord(value) || typeof value.profile_path !== "string" || !isAbsolute(value.profile_path)) fail("invalid_local_host");
    if (noStart) return { profilePath: value.profile_path, url: "", token: "" };
    if (typeof value.url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value.url)
        || typeof value.web_token !== "string" || !/^[a-f0-9]{48}$/u.test(value.web_token)
        || value.protocol !== "amazme-http/1" || value.role !== "host" || value.storage_format !== 2) fail("invalid_local_host");
    return { profilePath: value.profile_path, url: value.url, token: value.web_token };
}

async function transientHost(cwd:string, workspace?:string): Promise<PythonHostConnection> {
	const source = (await localProfile(cwd)).profilePath;
	const child = spawn(backendCommand(), ["transient", "--source-profile", source, "--workspace", resolve(cwd),
		...(workspace ? ["--workspace-name",workspace] : [])], {stdio:["pipe","pipe","inherit"],detached:true,env:{...process.env,AMAZME_NODE:process.env.AMAZME_NODE || process.execPath}});
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

/** Attach to an explicit endpoint, or let Python ensure the local persistent Host. */
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
    const directory = options.sessionDir ? resolve(options.cwd, options.sessionDir) : undefined;
    const separate = directory !== undefined && directory !== resolve(getAgentDir());
    const source = separate ? (await localProfile(options.cwd)).profilePath : undefined;
    const host = await localProfile(options.cwd, separate ? join(directory, "python-host") : undefined, source, false);
    return { url: host.url, token: host.token };
}
