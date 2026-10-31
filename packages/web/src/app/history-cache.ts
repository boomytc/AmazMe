import type { HistoryPage } from "../generated/contracts.ts";
import type { ClientConnection, PythonClient } from "../transport/client.ts";
import { seq } from "../transport/stream.ts";

export class HistoryCache {
	history?: HistoryPage;
	historyLoading = false;
	private historyGeneration = 0;
	private historyConnection?: ClientConnection;
	historyLatestRevision = 0n;
	private historyStarted = false;
	private readonly client: PythonClient;
	private readonly changed: () => void;
	constructor(client: PythonClient, changed: () => void) {
		this.client = client;
		this.changed = changed;
	}
	reset(): void {
		this.history = undefined;
		this.historyConnection = undefined;
		this.historyLatestRevision = 0n;
		this.historyStarted = false;
		this.historyGeneration++;
		this.historyLoading = false;
	}
	latestTranscriptRevision(connection: ClientConnection): bigint {
		return (connection.snapshot?.requests ?? [])
			.filter((row) => row.kind === "root")
			.reduce((latest, row) => {
				const revision = seq(row.accepted_revision ?? "0");
				return revision > latest ? revision : latest;
			}, 0n);
	}
	async loadHistory(
		connection: ClientConnection,
		older: boolean,
		all = false,
	): Promise<void> {
		if (!older && this.history && this.historyConnection === connection) return;
		if (this.historyConnection !== connection) {
			this.historyConnection = connection;
			this.historyGeneration++;
			this.historyLoading = false;
		}
		if (this.historyLoading) return;
		const generation = ++this.historyGeneration;
		this.historyLoading = true;
		this.changed();
		const current = () =>
			connection.active() && generation === this.historyGeneration;
		const merge = (page: HistoryPage, prepend: boolean) => {
			if (page.session_id !== connection.sessionId)
				throw new Error("历史记录的会话归属不匹配");
			const previous = this.history;
			const ordered = prepend
				? [...page.requests, ...(previous?.requests ?? [])]
				: [...(previous?.requests ?? []), ...page.requests];
			const rows = new Map<string, HistoryPage["requests"][number]>();
			for (const row of ordered) {
				const previous = rows.get(row.request_id);
				if (
					!previous ||
					seq(row.revision ?? "0") >= seq(previous.revision ?? "0")
				)
					rows.set(row.request_id, row);
			}
			const events = new Map(
				[...(previous?.events ?? []), ...page.events].map((event) => [
					`${event.request_id}:${event.kind}:${event.message?.key ?? event.text}`,
					event,
				]),
			);
			this.history = {
				...page,
				requests: [...rows.values()],
				events: [...events.values()],
				truncated: page.truncated || previous?.truncated,
				...(!prepend && this.historyStarted && previous
					? { cursor: previous.cursor, more: previous.more }
					: {}),
			};
		};
		try {
			if (
				!older ||
				!this.historyStarted ||
				this.latestTranscriptRevision(connection) > this.historyLatestRevision
			) {
				const page = await this.client.call(
					"GET /api/v1/sessions/{session}/history",
					{ path: { session: connection.sessionId } },
				);
				if (!current()) return;
				merge(page, false);
				this.historyLatestRevision = page.requests.reduce((latest, row) => {
					const revision = seq(row.accepted_revision ?? "0");
					return revision > latest ? revision : latest;
				}, 0n);
			}
			if (!older) return;
			this.historyStarted = true;
			do {
				if (!this.history?.more || !this.history.cursor) break;
				const before = this.history.cursor;
				const page = await this.client.call(
					"GET /api/v1/sessions/{session}/history",
					{ path: { session: connection.sessionId }, query: { before } },
				);
				if (!current()) return;
				if (page.more && (!page.cursor || page.cursor === before))
					throw new Error("历史游标未前进");
				merge(page, true);
				this.changed();
			} while (all && current());
		} finally {
			if (current()) {
				this.historyLoading = false;
				this.changed();
			}
		}
	}
}
