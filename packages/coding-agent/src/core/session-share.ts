import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_RADIUS_GATEWAY } from "@amazme/ai/providers/radius-config";
import { getAuthCredential } from "../cli/auth-command.ts";
import { getShareViewerUrl } from "../config.ts";
import type { AgentSession } from "./agent-session.ts";
import { exportSessionToJsonl } from "./session-export.ts";

/** Where a share goes: Radius first, a gist, or the reader's configured default. */
export type ShareDestination = "auto" | "radius" | "gist";

export interface ShareSuccess {
	readonly ok: true;
	/** The URL a reader opens; a gist share also exposes the gist itself. */
	readonly url: string;
	readonly gistUrl?: string;
}

export interface ShareFailure {
	readonly ok: false;
	/** Reader-facing reason, in the same words the terminal share uses. */
	readonly problem: string;
	readonly cancelled?: boolean;
}

export type ShareOutcome = ShareSuccess | ShareFailure;

export interface GhResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export interface ShareSessionOptions {
	readonly session: AgentSession;
	readonly destination: ShareDestination;
	/** Theme the exported HTML uses; the terminal passes its active theme. */
	readonly themeName?: string;
	readonly signal?: AbortSignal;
	/** Phase text for a progress surface ("Uploading to Radius..."). */
	readonly report?: (message: string) => void;
	readonly fetchImpl?: typeof fetch;
	readonly runGh?: (args: readonly string[], signal?: AbortSignal) => Promise<GhResult>;
	/** Local CLI check; the default asks `gh auth status` synchronously. */
	readonly checkGhAuth?: () => GhAuthStatus;
	readonly tempRoot?: string;
	/** Injectables for tests: the default writes through the session. */
	readonly exportJsonl?: (file: string) => void;
	readonly exportHtml?: (file: string) => Promise<void>;
}

/** Trailing `amazme.share` entry carrying the system prompt and tool schemas for the session viewer. */
export function createShareTrailingEntries(
	session: AgentSession,
	parentId: string | null,
	timestamp: string,
): object[] {
	return [
		{
			type: "custom",
			customType: "amazme.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	];
}

/** Export the current branch with presentation metadata for Radius. */
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) =>
		createShareTrailingEntries(session, parentId, timestamp),
	);
}

function cancelled(options: { readonly signal?: AbortSignal }): ShareFailure | undefined {
	return options.signal?.aborted === true
		? { ok: false, problem: "Share cancelled", cancelled: true }
		: undefined;
}

function runGhProcess(args: readonly string[], signal?: AbortSignal): Promise<GhResult> {
	return new Promise((resolve) => {
		// No options object: the spawn call stays the same shape callers and tests expect.
		const proc = spawn("gh", [...args]);
		let stdout = "";
		let stderr = "";
		const onAbort = (): void => {
			proc.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (result: GhResult): void => {
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		proc.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		proc.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		proc.on("error", (error: NodeJS.ErrnoException) => {
			finish({ code: null, stdout, stderr: stderr || error.message });
		});
		proc.on("close", (code) => finish({ code, stdout, stderr }));
	});
}

export type GhAuthStatus = "ok" | "logged-out" | "missing";

function defaultGhAuth(): GhAuthStatus {
	try {
		const result = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (result.error !== undefined) return "missing";
		return result.status === 0 ? "ok" : "logged-out";
	} catch {
		return "missing";
	}
}

async function uploadToRadius(file: string, options: ShareFilesOptions, token: string): Promise<ShareOutcome> {
	options.report?.("Uploading to Radius...");
	const body = fs.readFileSync(file);
	const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
	url.searchParams.set("visibility", "organization");
	url.searchParams.set("title", "AmazMe session");
	try {
		const response = await (options.fetchImpl ?? fetch)(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-ndjson",
				"Content-Length": String(body.byteLength),
			},
			body,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		const abortedAfterUpload = cancelled(options);
		if (abortedAfterUpload) return abortedAfterUpload;
		const json = (await response.json().catch(() => null)) as {
			artifact?: { canonical_url: string };
			error?: string;
		} | null;
		const abortedAfterBody = cancelled(options);
		if (abortedAfterBody) return abortedAfterBody;
		if (!response.ok || !json?.artifact) {
			return {
				ok: false,
				problem: `Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`,
			};
		}
		return { ok: true, url: json.artifact.canonical_url };
	} catch (error: unknown) {
		const aborted = cancelled(options);
		if (aborted) return aborted;
		return {
			ok: false,
			problem: `Failed to upload Radius artifact: ${error instanceof Error ? error.message : "Unknown error"}`,
		};
	}
}

async function shareViaGist(htmlFile: string, options: ShareFilesOptions): Promise<ShareOutcome> {
	const runGh = options.runGh ?? runGhProcess;
	const auth = (options.checkGhAuth ?? defaultGhAuth)();
	if (auth === "missing") {
		return {
			ok: false,
			problem: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
		};
	}
	if (auth === "logged-out") {
		return { ok: false, problem: "GitHub CLI is not logged in. Run 'gh auth login' first." };
	}
	const abortedAfterAuth = cancelled(options);
	if (abortedAfterAuth) return abortedAfterAuth;
	options.report?.("Creating gist...");
	const result = await runGh(["gist", "create", "--public=false", htmlFile], options.signal);
	const abortedAfterGist = cancelled(options);
	if (abortedAfterGist) return abortedAfterGist;
	if (result.code !== 0) {
		return { ok: false, problem: `Failed to create gist: ${result.stderr.trim() || "Unknown error"}` };
	}
	const gistUrl = result.stdout.trim();
	const gistId = gistUrl.split("/").pop();
	if (!gistId) return { ok: false, problem: "Failed to parse gist ID from gh output" };
	return { ok: true, url: getShareViewerUrl(gistId), gistUrl };
}

/** Files already exported by a caller that owns its own session store. */
export interface ShareFilesOptions {
	readonly jsonlFile: string;
	readonly htmlFile: string;
	readonly destination: ShareDestination;
	/** Radius credential for this share; undefined means the account is unavailable. */
	readonly radiusToken?: () => Promise<string | undefined>;
	readonly signal?: AbortSignal;
	readonly report?: (message: string) => void;
	readonly fetchImpl?: typeof fetch;
	readonly runGh?: (args: readonly string[], signal?: AbortSignal) => Promise<GhResult>;
	readonly checkGhAuth?: () => GhAuthStatus;
	/** Writes the HTML beside the JSONL; absent means the caller already exported it. */
	readonly exportHtml?: (file: string) => Promise<void>;
}

/** Publish two already-exported files, for a caller whose session store is not an AgentSession. */
export async function shareFilesToUrl(options: ShareFilesOptions): Promise<ShareOutcome> {
	const abort = cancelled(options);
	if (abort) return abort;
	if (options.destination !== "gist") {
		const token = await options.radiusToken?.();
		if (options.signal?.aborted === true) return { ok: false, problem: "Share cancelled", cancelled: true };
		if (token === undefined) {
			if (options.destination === "radius") {
				return { ok: false, problem: "Radius authentication is not configured. Run '/login radius' first." };
			}
		} else {
			return await uploadToRadius(options.jsonlFile, options, token);
		}
	}
	if (options.exportHtml !== undefined) {
		try {
			await options.exportHtml(options.htmlFile);
		} catch (error: unknown) {
			return {
				ok: false,
				problem: `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}
	}
	if (!fs.existsSync(options.htmlFile)) {
		return { ok: false, problem: "Failed to export session: HTML export is missing" };
	}
	return await shareViaGist(options.htmlFile, options);
}

/**
 * Export the current session and publish it, without a terminal.
 *
 * Radius is tried unless the reader chose a gist; an unavailable Radius account falls back
 * to a private gist when the destination is automatic. Every failure is a value, so a page
 * or a command can show the reason without catching an exception.
 */
export async function shareSessionToUrl(options: ShareSessionOptions): Promise<ShareOutcome> {
	const tempDir = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "pi-share-"));
	const jsonlFile = path.join(tempDir, "session.jsonl");
	const htmlFile = path.join(tempDir, "session.html");
	try {
		try {
			(options.exportJsonl ?? ((file: string) => exportSessionForShare(file, options.session)))(jsonlFile);
		} catch (error: unknown) {
			return {
				ok: false,
				problem: `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}
		const session = options.session;
		return await shareFilesToUrl({
			jsonlFile,
			htmlFile,
			destination: options.destination,
			radiusToken: async () => {
				if (!session.modelRuntime.getProvider("radius")) return undefined;
				return getAuthCredential(
					await session.modelRuntime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 }),
				);
			},
			...(options.signal === undefined ? {} : { signal: options.signal }),
			...(options.report === undefined ? {} : { report: options.report }),
			...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
			...(options.runGh === undefined ? {} : { runGh: options.runGh }),
			...(options.checkGhAuth === undefined ? {} : { checkGhAuth: options.checkGhAuth }),
			exportHtml:
				options.exportHtml ??
				(async (file: string) => {
					await session.exportToHtml(
						file,
						options.themeName === undefined ? {} : { themeName: options.themeName },
					);
				}),
		});
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort; the upload already read what it needed.
		}
	}
}
