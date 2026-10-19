import { createModels } from "@amazme/ai/models";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { createRegistry, Harness } from "@amazme/durable";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expandTildePath } from "../config.ts";
import { sessionEntriesToDurableDrafts, type SessionInteropReport } from "../core/session-interop.ts";
import { parseSessionEntries, type SessionEntry, type SessionHeader } from "../core/jsonl-transcript.ts";
import { openSessionStorage } from "./session-database.ts";
import { selectSession } from "./sessions.ts";

const context = BACKGROUND_CONTEXT;

export interface ImportSessionOptions {
	/** Defaults to the imported header's cwd, so the session appears in that project. */
	readonly cwd?: string;
	readonly sessionDir?: string;
}

export interface ImportSessionResult {
	readonly sessionId: string;
	readonly cwd: string;
	readonly directory?: string;
	readonly report: SessionInteropReport;
}

function headerOf(entries: ReturnType<typeof parseSessionEntries>): SessionHeader {
	const header = entries[0];
	if (header === undefined || header.type !== "session") throw new Error("Not an AmazMe session: the first record is not a session header");
	if (header.version !== 3) throw new Error(`Unsupported session version ${String(header.version)}; only version 3 can be imported`);
	if (header.parentSession !== undefined) throw new Error("Sessions created from another session cannot be imported as a new root");
	return header;
}

/**
 * Import only a linear terminal history. Branches are a terminal tree feature; flattening them
 * would duplicate abandoned messages and change what the model sees, so the caller must export
 * the active branch first or use the hosted handoff, which has its own lossless subset.
 */
function assertLinear(entries: ReturnType<typeof parseSessionEntries>): void {
	let parent: string | null = null;
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "session") continue;
		if (entry.parentId !== parent) throw new Error("Branched terminal sessions cannot be imported; export the active branch first");
		if (ids.has(entry.id)) throw new Error(`Duplicate terminal entry ${entry.id}`);
		ids.add(entry.id);
		parent = entry.id;
	}
}

/**
 * Import one terminal JSONL session into a new Durable session.
 *
 * This is one-way: the JSONL file is read, not changed. Entries the Durable transcript cannot
 * carry are counted in the report rather than dropped silently. The caller owns the created
 * session afterwards; a failed import removes the directory it created.
 */
export async function importSessionFile(file: string, options: ImportSessionOptions = {}): Promise<ImportSessionResult> {
	const content = await readFile(resolve(file), "utf8");
	const entries = parseSessionEntries(content);
	const header = headerOf(entries);
	assertLinear(entries);
	const cwd = options.cwd ?? header.cwd;
	const transcript = entries.slice(1).filter((entry): entry is SessionEntry => entry.type !== "session");
	const { drafts, report } = sessionEntriesToDurableDrafts(transcript);

	const location = await selectSession(cwd, false, { sessionDir: options.sessionDir });
	let harness: Harness | undefined;
	try {
		if (location.lease === undefined) throw new Error("Import requires persistent storage");
		harness = await Harness.open(
			await openSessionStorage(location.lease),
			{ models: createModels(), registry: createRegistry() },
			context,
		);
		const root = await harness.root(context);
		if (drafts.length > 0) {
			await root.commit(async (tx) => {
				for (const draft of drafts) await tx.appendEntry(root.id, draft);
			}, context);
		}
		await harness.close(context);
		harness = undefined;
		await location.release();
		return {
			sessionId: location.id,
			cwd: location.cwd,
			...(location.directory === undefined ? {} : { directory: location.directory }),
			report,
		};
	} catch (error) {
		await harness?.close(context).catch(() => {});
		await location.release().catch(() => {});
		if (location.directory !== undefined) await rm(location.directory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

function usage(): string {
	return [
		"Usage: amazme import <session.jsonl> [--session-dir <dir>]",
		"",
		"Imports one terminal JSONL session into a new Durable SQLite session.",
		"The JSONL file is left unchanged; unsupported entries are counted.",
	].join("\n");
}

/** CLI handler for `amazme import`. */
export async function runImportCommand(args: readonly string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(usage());
		return 0;
	}
	let sessionDir: string | undefined;
	let file: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--session-dir") {
			sessionDir = args[++index];
			if (sessionDir === undefined) {
				console.error("Error: --session-dir requires a value");
				return 1;
			}
		} else if (arg.startsWith("-")) {
			console.error(`Error: unknown option ${arg}`);
			return 1;
		} else if (file === undefined) {
			file = arg;
		} else {
			console.error("Error: import accepts one session file");
			return 1;
		}
	}
	if (file === undefined) {
		console.error(usage());
		return 1;
	}
	try {
		const imported = await importSessionFile(file, {
			...(sessionDir === undefined ? {} : { sessionDir: resolve(process.cwd(), expandTildePath(sessionDir)) }),
		});
		const skipped = Object.entries(imported.report.skipped);
		console.log(`Imported ${imported.report.carried} entries into durable session ${imported.sessionId}.`);
		if (imported.directory !== undefined) console.log(`Session directory: ${imported.directory}`);
		if (skipped.length > 0) console.log(`Skipped (not representable in durable): ${skipped.map(([kind, count]) => `${kind}×${count}`).join(", ")}`);
		return 0;
	} catch (error: unknown) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
