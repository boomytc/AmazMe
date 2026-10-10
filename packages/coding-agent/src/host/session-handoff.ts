/**
 * Hosted conversations are authoritative. A compatible, empty conversation may be seeded from
 * its terminal JSONL; later committed revisions export a mirror. This is not two-way synchronization.
 * Unsupported terminal semantics, divergent transcripts and external writes disable mirroring for
 * this handoff's lifetime, preserving the terminal file and publishing an actionable warning.
 */
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { Conversation, ConversationView, EntryRecord } from "@amazme/durable";
import { sessionEntriesToDurableDrafts } from "../core/session-interop.ts";
import type { SessionInteropReport } from "../core/session-interop.ts";
import { parseSessionEntries } from "../core/session-manager.ts";
import type { SessionEntry, SessionHeader } from "../core/session-manager.ts";
import { durableEntriesToSessionFile } from "../core/session-interop.ts";
import { readSessionFileSnapshot, SessionMirrorConflict } from "./session-mirror-file.ts";
import type { SessionFileFingerprint } from "./session-mirror-file.ts";
import { findLocalSessionPath, mirrorPath, projectSessionMirror, writeSessionMirror } from "./session-store.ts";
import type { SessionMirrorWarning } from "./services/session-mirror.ts";

export interface SessionHandoff {
	refresh(): Promise<void>;
	dispose(): Promise<void>;
	readonly warning: SessionMirrorWarning | null;
	subscribeWarning(listener: (warning: SessionMirrorWarning | null) => void): () => void;
}

export interface SessionHandoffOptions {
	readonly conversation: Conversation;
	readonly sessionId: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly sessionName?: () => Promise<string | undefined>;
	readonly report?: (line: string) => void;
}

function describe(report: SessionInteropReport): string {
	const skipped = Object.entries(report.skipped).map(([kind, count]) => `${kind}×${count}`).join(", ");
	return skipped.length === 0 ? `${report.carried} carried` : `${report.carried} carried, skipped ${skipped}`;
}

/** The lossless seed subset is a single chain of ordinary model messages without terminal metadata. */
function seedIssue(header: SessionHeader, entries: readonly SessionEntry[]): string | undefined {
	if (header.parentSession !== undefined) return "parentSession cannot be preserved";
	if (header.version !== 3) return "only version 3 terminal sessions can be mirrored";
	let parent: string | null = null;
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.parentId !== parent || ids.has(entry.id)) return "terminal branch tree cannot be preserved";
		if (entry.type !== "message" || !["user", "assistant", "toolResult", "system"].includes(entry.message.role)) {
			return "terminal metadata or message kind cannot be preserved";
		}
		ids.add(entry.id);
		parent = entry.id;
	}
	return undefined;
}

/** Parse the captured bytes without SessionManager.open, which can migrate and rewrite old files. */
function capturedTerminal(content: string): { header: SessionHeader; entries: SessionEntry[] } {
	const lines = content.split("\n").filter((line) => line.trim().length > 0);
	for (const [index, line] of lines.entries()) {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) {
			throw new SessionMirrorConflict("invalid terminal record");
		}
		const allowed = index === 0
			? ["type", "version", "id", "timestamp", "cwd", "parentSession"]
			: ["type", "id", "parentId", "timestamp", "message"];
		if (index === 0 || value.type === "message") {
			if (Object.keys(value).some((key) => !allowed.includes(key))) {
				throw new SessionMirrorConflict("terminal record has metadata that cannot be preserved");
			}
		}
		if (!("id" in value) || typeof value.id !== "string" || !("timestamp" in value) || typeof value.timestamp !== "string") {
			throw new SessionMirrorConflict("invalid terminal record identity");
		}
	}
	const [header, ...records] = parseSessionEntries(content);
	if (header?.type !== "session" || typeof header.cwd !== "string" || records.some((entry) => entry.type === "session")) {
		throw new SessionMirrorConflict("invalid terminal header");
	}
	return { header, entries: records.filter((entry) => entry.type !== "session") };
}

function seedMessagesRoundTrip(entries: readonly SessionEntry[]): boolean {
	const projection = sessionEntriesToDurableDrafts(entries);
	const exported = durableEntriesToSessionFile(projection.drafts.map((entry, id) => ({ ...entry, id })), { id: "seed", cwd: "", timestamp: new Date(0).toISOString() });
	return JSON.stringify(entries.map((entry) => entry.type === "message" ? entry.message : null)) ===
		JSON.stringify(exported.entries.filter((entry) => entry.type === "message").map((entry) => entry.message));
}

export async function startSessionHandoff(options: SessionHandoffOptions): Promise<SessionHandoff> {
	const report = options.report ?? ((line: string) => console.error(line));
	const existing = await findLocalSessionPath(options.cwd, options.sessionId);
	const path = existing ?? mirrorPath(options.cwd, options.sessionId, options.createdAt);
	const listeners = new Set<(warning: SessionMirrorWarning | null) => void>();
	let warning: SessionMirrorWarning | null = null;
	let blocked = false;
	let fingerprint: SessionFileFingerprint | undefined;
	const publishWarning = (detail: string, stop: boolean): void => {
		blocked ||= stop;
		warning = { path, detail };
		report(`amazme: session ${options.sessionId} terminal mirror paused; original file preserved: ${path}: ${detail}`);
		for (const listener of listeners) listener(warning);
	};

	let terminalContent: string | undefined;
	try {
		const snapshot = await readSessionFileSnapshot(path);
		fingerprint = snapshot?.fingerprint;
		terminalContent = snapshot?.content;
		if (existing === undefined && snapshot !== undefined) publishWarning("target exists but is not a listed terminal session", true);
	} catch (error: unknown) { publishWarning(message(error), true); }

	const first = await options.conversation.entries({ order: "ascending" }, 1, undefined, BACKGROUND_CONTEXT);
	if (!blocked && first.items.length === 0 && existing !== undefined) {
		try {
			const local = terminalContent === undefined ? undefined : capturedTerminal(terminalContent);
			if (local === undefined || local.header.id !== options.sessionId || local.header.cwd !== options.cwd) {
				publishWarning("terminal session identity changed before import", true);
			} else {
				const projection = sessionEntriesToDurableDrafts(local.entries);
				const issue = seedIssue(local.header, local.entries) ?? (seedMessagesRoundTrip(local.entries) ? undefined : "terminal messages cannot round trip without loss");
				if (issue !== undefined) {
					publishWarning(`${issue}; import and mirroring disabled (${describe(projection.report)})`, true);
				} else {
					for (const entry of projection.drafts) {
						await options.conversation.submit({ type: "write", entry }, BACKGROUND_CONTEXT);
					}
					report(`amazme: session ${options.sessionId} started from the terminal transcript: ${describe(projection.report)}`);
				}
			}
		} catch (error: unknown) { publishWarning(message(error), true); }
	}

	const view = await options.conversation.viewState(BACKGROUND_CONTEXT);
	if (!blocked && first.items.length > 0 && terminalContent !== undefined) {
		const name = await options.sessionName?.();
		const projection = projectSessionMirror({
			path, sessionId: options.sessionId, cwd: options.cwd, createdAt: options.createdAt,
			...(name === undefined ? {} : { name }), entries: view.value.entries,
		});
		if (projection.content !== terminalContent) {
			publishWarning("existing terminal transcript differs from the durable export", true);
		}
	}
	let disposed = false;
	let signature = "";
	let writing: Promise<void> = Promise.resolve();

	const mirror = (entries: readonly EntryRecord[], force = false): void => {
		if (blocked) return;
		const next = entries.map((entry) => String(entry.id)).join(",");
		if (next === signature && !force) return;
		signature = next;
		writing = writing.then(async () => {
			if (blocked) return;
			const name = await options.sessionName?.();
			const projection = await writeSessionMirror({
				path, sessionId: options.sessionId, cwd: options.cwd, createdAt: options.createdAt,
				...(name === undefined ? {} : { name }), entries, guard: { expected: fingerprint },
			});
			fingerprint = projection.fingerprint;
			if (warning !== null) {
				warning = null;
				for (const listener of listeners) listener(null);
			}
			if (Object.keys(projection.skipped).length > 0) {
				report(`amazme: mirrored session ${options.sessionId}: ${describe(projection)}`);
			}
		}).catch((error: unknown) => {
			// Retry I/O failures without accepting changed bytes as a new baseline. Conflicts stay blocked.
			signature = "";
			publishWarning(message(error), error instanceof SessionMirrorConflict);
		});
	};
	const unsubscribe = view.subscribe((value: ConversationView) => {
		if (!disposed) mirror(value.entries);
	});
	mirror(view.value.entries);
	return {
		get warning() { return warning; },
		subscribeWarning(listener) {
			listeners.add(listener);
			listener(warning);
			return () => { listeners.delete(listener); };
		},
		refresh() {
			if (!disposed) mirror(view.value.entries, true);
			return writing;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			view.dispose();
			await writing;
			listeners.clear();
		},
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
