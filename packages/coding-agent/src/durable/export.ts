import { mkdtemp, copyFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { Message } from "@amazme/ai";
import { createModels } from "@amazme/ai/models";
import { createRegistry, Harness } from "@amazme/durable";
import type { ConversationId } from "@amazme/durable";
import { openNodeSqliteStorage } from "@amazme/durable/storage/sqlite/node";
import { exportFromFile } from "../core/export-html/index.ts";
import { durableEntriesToSessionFile, type SessionInteropReport } from "../core/session-interop.ts";
import { readFocus } from "./session-surface.ts";

const context = BACKGROUND_CONTEXT;

export type DurableExportFormat = "jsonl" | "html";

export interface DurableExportOptions {
	readonly output?: string;
	readonly format?: DurableExportFormat;
	/** Defaults to the root agent's stored cwd, then the process cwd. */
	readonly cwd?: string;
}

export interface DurableExportResult {
	readonly path: string;
	readonly format: DurableExportFormat;
	readonly report: SessionInteropReport;
}

export interface DurableEntryExportOptions {
	readonly id: string;
	readonly cwd: string;
	readonly output?: string;
	readonly format: DurableExportFormat;
}

/** Write already-read Durable entries as JSONL or HTML. Used by file export and the live RPC path. */
export async function writeDurableExport(
	entries: readonly { readonly id: unknown; readonly kind: string; readonly model?: readonly Message[] }[],
	options: DurableEntryExportOptions,
): Promise<DurableExportResult> {
	const temporary = await mkdtemp(join(tmpdir(), "amazme-durable-export-"));
	try {
		const projected = durableEntriesToSessionFile(entries, {
			id: options.id,
			cwd: options.cwd,
			timestamp: new Date().toISOString(),
		});
		const jsonl = join(temporary, "session.jsonl");
		await writeFile(jsonl, `${projected.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
		const output = resolve(options.output ?? (options.format === "jsonl" ? `${options.id}.jsonl` : `amazme-session-${options.id}.html`));
		if (options.format === "jsonl") await copyFile(jsonl, output);
		else await exportFromFile(jsonl, output);
		return { path: output, format: options.format, report: projected.report };
	} finally {
		await rm(temporary, { recursive: true, force: true }).catch(() => {});
	}
}

async function sessionDatabase(path: string): Promise<string> {
	const resolved = resolve(path);
	try {
		if ((await stat(resolved)).isDirectory()) return join(resolved, "session.sqlite");
	} catch {
		// Fall through to the explicit file error below.
	}
	return resolved;
}

async function copyDatabase(source: string, target: string): Promise<void> {
	await copyFile(source, target);
	for (const suffix of ["-wal", "-shm"]) {
		await copyFile(`${source}${suffix}`, `${target}${suffix}`).catch(() => {});
	}
}

/**
 * Export one Durable SQLite session to the terminal JSONL bundle or the HTML viewer.
 *
 * The source database is never opened. A temporary copy (including WAL/SHM sidecars) is read
 * with the normal Harness, so an export cannot migrate, lock, or write the live session. The
 * transcript is the persisted focus, or the root when the session has not focused a branch.
 * Other branches stay in the source database. Close a running session before exporting so the
 * copied WAL is complete.
 */
export async function exportDurableSession(path: string, options: DurableExportOptions = {}): Promise<DurableExportResult> {
	const source = await sessionDatabase(path);
	const format = options.format ?? (options.output?.endsWith(".jsonl") ? "jsonl" : "html");
	const temporary = await mkdtemp(join(tmpdir(), "amazme-durable-export-"));
	const copy = join(temporary, "session.sqlite");
	let harness: Harness | undefined;
	try {
		await copyDatabase(source, copy);
		harness = await Harness.open(
			await openNodeSqliteStorage(copy),
			{ models: createModels(), registry: createRegistry() },
			context,
		);
		const root = await harness.root(context);
		const focusId = await readFocus(harness, context);
		const focused = focusId.length === 0 ? undefined : await harness.conversation(Number(focusId) as ConversationId, context);
		const conversation = focused ?? root;
		const view = await conversation.viewState(context);
		const agent = view.value.docs["amazme.agent"] as { cwd?: unknown } | undefined;
		const cwd = options.cwd ?? (typeof agent?.cwd === "string" ? agent.cwd : process.cwd());
		const sessionId = basename(dirname(source));
		const entries = view.value.entries;
		view.dispose();
		return await writeDurableExport(entries, { id: sessionId, cwd, ...(options.output === undefined ? {} : { output: options.output }), format });
	} finally {
		await harness?.close(context).catch(() => {});
		await rm(temporary, { recursive: true, force: true }).catch(() => {});
	}
}

function usage(): string {
	return [
		"Usage: amazme export <session.sqlite|session-dir> [output] [--jsonl] [--html]",
		"",
		"Exports a Durable session's active transcript to JSONL or HTML.",
		"The selected output extension chooses the format unless --jsonl or --html is given.",
	].join("\n");
}

/** CLI handler for `amazme export`. */
export async function runExportCommand(args: readonly string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(usage());
		return 0;
	}
	let format: DurableExportFormat | undefined;
	let session: string | undefined;
	let output: string | undefined;
	for (const arg of args) {
		if (arg === "--jsonl") format = "jsonl";
		else if (arg === "--html") format = "html";
		else if (arg.startsWith("-")) {
			console.error(`Error: unknown option ${arg}`);
			return 1;
		} else if (session === undefined) session = arg;
		else if (output === undefined) output = arg;
		else {
			console.error("Error: export accepts one session and one output");
			return 1;
		}
	}
	if (session === undefined) {
		console.error(usage());
		return 1;
	}
	try {
		const result = await exportDurableSession(session, { ...(output === undefined ? {} : { output }), ...(format === undefined ? {} : { format }) });
		console.log(`Exported to: ${result.path}`);
		const skipped = Object.entries(result.report.skipped);
		if (skipped.length > 0) console.log(`Skipped (not representable in JSONL): ${skipped.map(([kind, count]) => `${kind}×${count}`).join(", ")}`);
		return 0;
	} catch (error: unknown) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
