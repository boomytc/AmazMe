/**
 * The hosted side of the terminal handoff: a hosted session opened under a terminal session's id
 * starts from that session's transcript when it has none of its own, and keeps the terminal's file
 * current while it runs. That is what makes one session visible and continuable from either client:
 * the terminal lists the mirror, and the host reads it back when the terminal's copy is the newer
 * one, or when the hosted session is created from it.
 *
 * Both directions go through the pure projections in `core/session-interop.ts`; what could not be
 * carried is reported and logged here rather than dropped quietly.
 */
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { Conversation, ConversationView, EntryRecord } from "@amazme/durable";
import { sessionEntriesToDurableDrafts, type SessionInteropReport } from "../core/session-interop.ts";
import { findLocalSessionPath, mirrorPath, readLocalSession, writeSessionMirror } from "./session-store.ts";

export interface SessionHandoff {
	/** Seed, mirror and release the subscription; repeated calls are harmless. */
	dispose(): Promise<void>;
}

export interface SessionHandoffOptions {
	readonly conversation: Conversation;
	readonly sessionId: string;
	readonly cwd: string;
	readonly createdAt: number;
	/** The display name `/name` reads, copied into the terminal file on each rewrite. */
	readonly sessionName?: () => Promise<string | undefined>;
	/** Where the report goes: the worker's log, and the tests' capture. */
	readonly report?: (line: string) => void;
}

function describe(report: SessionInteropReport): string {
	const skipped = Object.entries(report.skipped)
		.map(([kind, count]) => `${kind}×${count}`)
		.join(", ");
	return skipped.length === 0 ? `${report.carried} carried` : `${report.carried} carried, skipped ${skipped}`;
}

/**
 * Start the handoff for one hosted session: seed it from the terminal's file when the durable
 * transcript is empty, then mirror every committed transcript revision back to that file.
 */
export async function startSessionHandoff(options: SessionHandoffOptions): Promise<SessionHandoff> {
	const report = options.report ?? ((line: string) => console.error(line));
	// The terminal's own file for this id, when it has one: the session keeps living in that file
	// rather than in a second copy beside it.
	const existing = await findLocalSessionPath(options.cwd, options.sessionId).catch(() => undefined);
	const path = existing ?? mirrorPath(options.cwd, options.sessionId, options.createdAt);
	// An empty hosted transcript under a terminal session's id starts from that session. The seed
	// runs before the view is attached, so the mirror's first pass already sees the seeded entries.
	const first = await options.conversation.entries({ order: "ascending" }, 1, undefined, BACKGROUND_CONTEXT);
	if (first.items.length === 0 && existing !== undefined) await seedFromTerminal(options, report);
	const view = await options.conversation.viewState(BACKGROUND_CONTEXT);
	let disposed = false;
	let signature = "";
	let writing: Promise<void> = Promise.resolve();

	const mirror = (entries: readonly EntryRecord[]): void => {
		const next = entries.map((entry) => String(entry.id)).join(",");
		if (next === signature) return;
		signature = next;
		// Mirrors run one at a time: a slow write must not be overtaken by the next revision.
		writing = writing
			.then(async () => {
				const name = await options.sessionName?.();
				const projection = await writeSessionMirror({
					path,
					sessionId: options.sessionId,
					cwd: options.cwd,
					createdAt: options.createdAt,
					...(name === undefined ? {} : { name }),
					entries,
				});
				if (Object.keys(projection.skipped).length > 0) {
					report(`amazme: mirrored session ${options.sessionId}: ${describe(projection)}`);
				}
			})
			.catch((error: unknown) => {
				report(`amazme: mirroring session ${options.sessionId} failed: ${message(error)}`);
			});
	};

	// Each new committed revision replaces the terminal's copy of this session.
	const unsubscribe = view.subscribe((value: ConversationView) => {
		if (disposed) return;
		mirror(value.entries);
	});
	mirror(view.value.entries);

	return {
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			view.dispose();
			await writing;
		},
	};
}

/** Write the terminal transcript into the hosted conversation, entry by entry. */
async function seedFromTerminal(
	options: SessionHandoffOptions,
	report: (line: string) => void,
): Promise<void> {
	const local = await readLocalSession(options.cwd, options.sessionId).catch(() => undefined);
	if (local === undefined) return;
	const { drafts, report: projection } = sessionEntriesToDurableDrafts(local.entries);
	for (const entry of drafts) {
		await options.conversation.submit({ type: "write", entry }, BACKGROUND_CONTEXT);
	}
	report(`amazme: session ${options.sessionId} started from the terminal transcript: ${describe(projection)}`);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
