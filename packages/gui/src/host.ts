import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { parsePythonReadyLine, type PythonReady } from "./python-backend.ts";

/** Exit data is diagnostic; future signal names remain valid. */
export interface HostExitDetail {
	readonly code: number | null;
	readonly signal: string | null;
	readonly tail: string;
}

/** Why `start` rejected. `message` is the sentence the rejection Error carries, without the tail. */
export type HostStartupFailure =
	| {
			readonly kind: "spawn-error" | "invalid-output";
			readonly message: string;
			readonly tail: string;
	  }
	| {
			readonly kind: "readiness-timeout";
			readonly timeoutMs: number;
			readonly message: string;
			readonly tail: string;
	  }
	| ({ readonly kind: "exit-before-ready"; readonly message: string } & HostExitDetail);


interface LocalConnection {
    readonly ready: PythonReady;
    readonly profilePath: string;
    readonly webToken: string;
    readonly workspace: string;
}

export interface HostSupervisor {
    start(): Promise<string>;
    shutdown(): Promise<void>;
    tail(): string;
    pythonReady(): PythonReady | undefined;
    connection(): LocalConnection | undefined;
}

const run = promisify(execFile);

function failureMessage(error: unknown): string {
    if (typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string") {
        try {
            const value: unknown = JSON.parse(error.stderr);
            if (typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
                && /^[a-z][a-z0-9_]{0,127}$/u.test(value.code)) {
                return "message" in value && typeof value.message === "string" && value.message.length > 0 && value.message.length <= 256
                    ? value.message : value.code;
            }
        } catch { /* Only the connector's structured failure crosses into the startup dialog. */ }
    }
    return "local_host_unavailable";
}

/** Only the short connector is our child. The persistent Host belongs to its profile. */
export function createHostConnection(options: {
    readonly executable: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly readinessTimeoutMs?: number;
    readonly onStartupFailure?: (failure: HostStartupFailure) => void;
}): HostSupervisor {
    let connection: LocalConnection | undefined;
    let starting: Promise<string> | undefined;
    let stopping: Promise<void> | undefined;
    const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !key.startsWith("ELECTRON_")));
    return {
        start() {
            starting ??= (async () => {
                try {
                    const result = await run(options.executable, ["connect", "--workspace", options.cwd], {
                        cwd: options.cwd, env, encoding: "utf8", timeout: options.readinessTimeoutMs ?? 310_000, maxBuffer: 1_048_576,
                    });
                    const value: unknown = JSON.parse(result.stdout);
                    const ready = parsePythonReadyLine(result.stdout);
                    if (ready === undefined || typeof value !== "object" || value === null
                        || !("profile_path" in value) || typeof value.profile_path !== "string" || !isAbsolute(value.profile_path)
                        || !("web_token" in value) || typeof value.web_token !== "string" || !/^[a-f0-9]{48}$/u.test(value.web_token)
                        || !("workspace" in value) || typeof value.workspace !== "string") throw new Error("invalid_local_host");
                    connection = { ready, profilePath: value.profile_path, webToken: value.web_token, workspace: value.workspace };
                    return ready.pageUrl;
                } catch (error: unknown) {
                    const message = failureMessage(error);
                    options.onStartupFailure?.({ kind: "spawn-error", message, tail: "" });
                    throw new Error(message);
                }
            })();
            return starting;
        },
        shutdown() {
            stopping ??= (async () => {
                if (connection === undefined) return;
                try {
                    await run(options.executable, ["stop", "--profile", connection.profilePath, "--expected-epoch", String(connection.ready.hostEpoch)], {
                        cwd: options.cwd, env, encoding: "utf8", timeout: 190_000, maxBuffer: 32_768,
                    });
                } catch { throw new Error("local_host_stop_failed"); }
            })().catch((error: unknown) => { stopping = undefined; throw error; });
            return stopping;
        },
        pythonReady: () => connection?.ready,
        connection: () => connection,
        tail: () => "",
    };
}
