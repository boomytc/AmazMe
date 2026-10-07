import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@amazme/chord";
import { Feedback, type FeedbackRecord, type FeedbackResult, type FeedbackState, type MessageRating } from "./feedback.ts";

/** How many ratings the store keeps; older ones fall off the end. */
export const FEEDBACK_MAX_RECORDS = 500;

export interface FeedbackServiceOptions {
	/** The agent directory: the ratings file lives beside the settings the CLI reads. */
	readonly agentDir: string;
}

interface FeedbackFile {
	readonly version: number;
	readonly records: readonly FeedbackRecord[];
}

function isRating(value: unknown): value is MessageRating {
	return value === "up" || value === "down";
}

/** Keep only what the store accepts: a rating of a named answer. */
function parseRecord(value: unknown): FeedbackRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.sessionId !== "string" ||
		typeof record.conversationId !== "string" ||
		typeof record.entryId !== "string" ||
		!isRating(record.rating) ||
		typeof record.at !== "number"
	) {
		return undefined;
	}
	return {
		sessionId: record.sessionId,
		conversationId: record.conversationId,
		entryId: record.entryId,
		rating: record.rating,
		note: typeof record.note === "string" ? record.note : null,
		at: record.at,
	};
}

/**
 * The ratings store: one JSON file in the agent directory, written atomically (a temporary file and
 * a rename), read back at activation and on demand. The same file a CLI could read, so a rating
 * given in the browser is not trapped in it.
 */
export function createFeedbackService(
	options: FeedbackServiceOptions,
	createState: (initial: FeedbackState) => MutableReplicatedState<FeedbackState>,
) {
	const path = join(options.agentDir, "feedback.json");
	const state = createState({ revision: 1, path, records: [] });
	let records: FeedbackRecord[] = [];

	const publish = (context: Context): void => {
		state.change(context, (draft) => {
			draft.revision += 1;
			draft.path = path;
			draft.records = records;
		});
	};

	const write = async (): Promise<void> => {
		const body: FeedbackFile = { version: 1, records };
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(body, null, "\t")}\n`, "utf8");
		await rename(temporary, path);
	};

	const load = async (context: Context): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(path, "utf8"));
		} catch {
			records = [];
			publish(context);
			return;
		}
		const list = typeof parsed === "object" && parsed !== null ? (parsed as { records?: unknown }).records : undefined;
		records = (Array.isArray(list) ? list : []).flatMap((entry) => {
			const record = parseRecord(entry);
			return record === undefined ? [] : [record];
		});
		publish(context);
	};

	const identityOf = (request: { sessionId: string; conversationId: string; entryId: string }): string =>
		`${request.sessionId}\u0000${request.conversationId}\u0000${request.entryId}`;

	return {
		service: {
			state,
			async rate(
				request: {
					readonly sessionId: string;
					readonly conversationId: string;
					readonly entryId: string;
					readonly rating: MessageRating;
					readonly note?: string;
				},
				context: Context,
			): Promise<FeedbackResult> {
				if (request.entryId.length === 0 || request.sessionId.length === 0) {
					return { ok: false, problem: "A rating needs the answer it belongs to." };
				}
				const identity = identityOf(request);
				const note = request.note === undefined || request.note.trim().length === 0 ? null : request.note.trim();
				const record: FeedbackRecord = {
					sessionId: request.sessionId,
					conversationId: request.conversationId,
					entryId: request.entryId,
					rating: request.rating,
					note,
					at: Date.now(),
				};
				records = [record, ...records.filter((candidate) => identityOf(candidate) !== identity)].slice(
					0,
					FEEDBACK_MAX_RECORDS,
				);
				await write();
				publish(context);
				return { ok: true };
			},
			async retract(
				request: { readonly sessionId: string; readonly conversationId: string; readonly entryId: string },
				context: Context,
			): Promise<FeedbackResult> {
				const identity = identityOf(request);
				const next = records.filter((candidate) => identityOf(candidate) !== identity);
				if (next.length === records.length) return { ok: false, problem: "That answer has no rating." };
				records = next;
				await write();
				publish(context);
				return { ok: true };
			},
			async reload(context: Context): Promise<void> {
				await load(context);
			},
		},
		/** The starting read, for the facet's activation. */
		activate: (context: Context) => load(context),
	};
}

/** The feedback service as a facet: it owns the file's state and reads it once at activation. */
export function createFeedbackFacet(options: FeedbackServiceOptions): Facet {
	return defineFacet({
		id: "@pi/feedback",
		setup(env) {
			const runtime = createFeedbackService(options, (initial) => env.replicatedState(initial));
			env.provide(Feedback, runtime.service);
			env.onActivate(() => runtime.activate(BACKGROUND_CONTEXT));
		},
	});
}
