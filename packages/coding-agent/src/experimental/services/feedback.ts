import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/** How a reader rated one answer. */
export type MessageRating = "up" | "down";

/** One rating, as the store keeps it. */
export interface FeedbackRecord {
	/** The answer's identity: its session, conversation, and entry. */
	sessionId: string;
	conversationId: string;
	entryId: string;
	rating: MessageRating;
	/** An optional note; absent when the reader only rated. */
	note: string | null;
	at: number;
}

export interface FeedbackState {
	revision: number;
	/** Where the ratings are stored, so a reader can find the file. */
	path: string;
	/** Newest first. */
	records: FeedbackRecord[];
}

/** What rating one answer produced; a rejected identity is a value, not a thrown call. */
export type FeedbackResult = { readonly ok: true } | { readonly ok: false; readonly problem: string };

/** The reader's ratings of individual answers, kept in one file the CLI can read too. */
export interface Feedback {
	readonly state: ReplicatedState<FeedbackState>;
	/** Rate one answer; rating it again replaces what was there. */
	rate(
		request: {
			readonly sessionId: string;
			readonly conversationId: string;
			readonly entryId: string;
			readonly rating: MessageRating;
			readonly note?: string;
		},
		context: Context,
	): Promise<FeedbackResult>;
	/** Withdraw one answer's rating. */
	retract(
		request: { readonly sessionId: string; readonly conversationId: string; readonly entryId: string },
		context: Context,
	): Promise<FeedbackResult>;
	/** Re-read the file, discarding what another process changed. */
	reload(context: Context): Promise<void>;
}

export const Feedback = defineService<Feedback>("amazme.feedback");
