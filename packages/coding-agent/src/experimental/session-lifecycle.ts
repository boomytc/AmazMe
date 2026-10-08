import type { Context } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { type Conversation, type Cursor, type EntryRecord, type Harness, InboxDoc, UserEntry } from "@amazme/durable";

/** A stable first-input title, bounded by Unicode characters rather than UTF-16 units. */
export function automaticSessionName(text: string): string {
	const normalized = text.replace(/\s+/gu, " ").trim();
	const characters = Array.from(normalized);
	return characters.length > 60 ? `${characters.slice(0, 59).join("")}…` : normalized;
}

function inputTitle(entry: EntryRecord, imageTitle: string): string | undefined {
	if (entry.kind !== UserEntry.kind) return undefined;
	const message = entry.model?.find((item) => item.role === "user");
	if (message?.role !== "user") return undefined;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join(" ");
	return automaticSessionName(text) || imageTitle;
}

/** Read durable history, including entries outside the active context after a reset or compaction. */
export async function firstSessionTitle(conversation: Conversation, imageTitle: string): Promise<string | undefined> {
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "ascending" }, 128, cursor, BACKGROUND_CONTEXT);
		for (const entry of page.items) {
			const title = inputTitle(entry, imageTitle);
			if (title !== undefined) return title;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

/** An empty session has no stored entries, queued inputs, or live tasks in any conversation. */
export function isSessionEmpty(harness: Harness, context: Context): Promise<boolean> {
	return harness.commit(async (tx) => {
		for (const status of ["pending", "running", "waiting", "completing"] as const) {
			if ((await tx.scanTasks({ status }, 1)).items.length > 0) return false;
		}
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanConversations({}, 128, cursor);
			for (const conversation of page.items) {
				if ((await tx.scanEntries({ conversationId: conversation.id }, 1)).items.length > 0) return false;
				if ((await tx.doc(InboxDoc, conversation.id)).items.length > 0) return false;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return true;
	}, context);
}

/** Only committed user input names a session. Reopening also recovers a missed notification. */
export function watchSessionTitle(
	harness: Harness,
	conversation: Conversation,
	imageTitle: string,
	publish: (title: string) => Promise<void>,
): () => void {
	let published = false;
	let disposed = false;
	let reading = false;
	let dirty = false;
	const refresh = async (): Promise<void> => {
		if (disposed || published) return;
		dirty = true;
		if (reading) return;
		reading = true;
		try {
			do {
				dirty = false;
				const title = await firstSessionTitle(conversation, imageTitle);
				if (title !== undefined && !disposed) {
					await publish(title);
					published = true;
				}
			} while (dirty && !published && !disposed);
		} finally {
			reading = false;
		}
	};
	const request = (): void => {
		void refresh().catch((error: unknown) => console.error("Session title:", error));
	};
	const unsubscribe = harness.subscribeCommits((publication) => {
		if (
			publication.changes.some(
				(change) =>
					change.type === "entry" &&
					change.value.conversationId === conversation.id &&
					change.value.kind === UserEntry.kind,
			)
		)
			request();
	});
	request();
	return () => {
		disposed = true;
		unsubscribe();
	};
}
