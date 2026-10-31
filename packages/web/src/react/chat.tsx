import type { PageRenderer } from "../render.ts";
import type { WebView } from "../view.ts";
import { ChatComposer } from "./chat-composer.tsx";
import { ChatTranscript } from "./chat-transcript.tsx";

/** The conversation state and empty-state affordances owned by the transcript surface. */
export type TranscriptView = Pick<
	WebView,
	| "locale"
	| "transcriptScope"
	| "attachedId"
	| "readOnly"
	| "blocks"
	| "history"
	| "status"
	| "busy"
	| "welcome"
	| "roster"
	| "rosterFilter"
	| "newSession"
	| "sessionDraft"
	| "archivedAttached"
	| "model"
	| "empty"
>;

/** The host projections consumed by the composer and the cards directly above it. */
export type ComposerView = Pick<
	WebView,
	| "locale"
	| "transcriptScope"
	| "attachedId"
	| "readOnly"
	| "sessionDraft"
	| "attachments"
	| "approvals"
	| "questions"
	| "queue"
	| "palette"
	| "run"
	| "model"
	| "modelPending"
	| "approvalPolicy"
	| "busy"
	| "suggestion"
	| "commandLine"
	| "shortcuts"
	| "meter"
>;

export interface TranscriptProps {
	readonly view: TranscriptView;
	readonly actions: PageRenderer;
}

export interface ComposerProps {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
	readonly draft: string;
	readonly active: boolean;
	readonly restoreFocusRequest: number;
}

/** The conversation transcript, search, selection quoting, and empty state. */
export function Transcript({ view, actions }: TranscriptProps) {
	return <ChatTranscript view={view} actions={actions} />;
}

/** The draft editor and every pending decision or submission around it. */
export function Composer({
	view,
	actions,
	draft,
	active,
	restoreFocusRequest,
}: ComposerProps) {
	return (
		<ChatComposer
			view={view}
			actions={actions}
			draft={draft}
			active={active}
			restoreFocusRequest={restoreFocusRequest}
		/>
	);
}
