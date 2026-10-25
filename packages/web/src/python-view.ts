import * as actions from "./actions.ts";
import { commandPalette, type CommandLike } from "./commands.ts";
import { dockView, type DockView } from "./dock.ts";
import type { Locale } from "./locale.ts";
import type { ModelConnectionsLike } from "./model-connections.ts";
import type { PanelView } from "./panels.ts";
import { isRecord } from "./python-api.ts";
import type { ClientConnection } from "./python-client.ts";
import type { ModelCatalog, Session, SessionModel, Snapshot, UsageReport, WorkspaceGrantView } from "./python-contracts.ts";
import { requestStatus, settled } from "./python-stream.ts";
import { shortcuts } from "./shortcuts.ts";
import { translate } from "./strings.ts";
import { collapsedToolArgs, expandedToolArgs } from "./tool-args.ts";
import { toolResultView } from "./tool-results.ts";
import type { Typography } from "./typography.ts";
import { approvalCards, approvalIndicator, failureView, modelPicker, rosterItems, runControls, welcomeCard, type Attachment, type ModelsStateLike, type SubmitMode, type TranscriptBlock, type WebView } from "./view.ts";

/** Project only the host's committed receipts and generation-matched previews. */
export function transcriptBlocks(locale: Locale, snapshot: Snapshot | undefined): TranscriptBlock[] {
	if (!snapshot) return [];
	const blocks: TranscriptBlock[] = [];
	for (const receipt of snapshot.requests) {
		if (receipt.text) blocks.push({ id: `${receipt.request_id}:user`, kind: "user", title: locale === "zh" ? "你" : "You", text: receipt.text, tone: "plain", running: false });
		const tools = new Map<string, TranscriptBlock>();
		for (const event of snapshot.events.filter(event => event.request_id === receipt.request_id && event.kind === "tool")) {
			let value: unknown;
			try { value = JSON.parse(event.text); } catch { value = undefined; }
			if (isRecord(value) && value.kind === "model") continue;
			if (!isRecord(value) || !isRecord(value.call) || typeof value.call.id !== "string" || typeof value.call.name !== "string" || typeof value.call.arguments !== "string") {
				tools.set(`event:${event.seq}`, { id: `${receipt.request_id}:tool:${event.seq}`, kind: "notice", title: "执行记录", text: event.text, tone: "muted", running: false });
				continue;
			}
			const call = value.call;
			let args: unknown;
			try { args = JSON.parse(String(call.arguments)); } catch { args = call.arguments; }
			const result = typeof value.result === "string" ? value.result : "";
			const error = typeof value.error === "string" ? value.error : "";
			const phase = typeof value.phase === "string" ? value.phase : "";
			const done = ["applied", "result", "observed", "succeeded", "completed", "failed", "unknown", "denied"].includes(phase);
			const id = `${receipt.request_id}:tool:${call.id}`;
			tools.set(String(call.id), { id, kind: "tool", title: String(call.name), toolName: String(call.name), text: result || error || (done ? phase : ""),
				toolArgs: { collapsed: collapsedToolArgs(args), expanded: expandedToolArgs(args), source: String(call.arguments) },
				...(done ? { result: toolResultView(locale, String(call.name), args, { content: [{ type: "text", text: result || error }], isError: Boolean(error) || ["failed", "unknown", "denied"].includes(phase) }) } : {}),
				tone: error ? "error" : "plain", running: !done && !settled.has(receipt.status) });
		}
		blocks.push(...tools.values());
		const preview = snapshot.previews?.find(item => item.request_id === receipt.request_id && item.run_id === receipt.run_id && item.generation === receipt.generation);
		const text = receipt.answer || (!settled.has(receipt.status) ? preview?.text : undefined);
		if (text) blocks.push({ id: `${receipt.request_id}:answer`, kind: "assistant", title: "AmazMe", text, tone: "plain", running: !settled.has(receipt.status), interrupted: receipt.status === "interrupted" || receipt.status === "cancelled" });
		if (receipt.error || ["failed", "unknown", "interrupted", "cancelled"].includes(receipt.status)) blocks.push({ id: `${receipt.request_id}:status`, kind: "notice", title: requestStatus[receipt.status], text: receipt.error ?? requestStatus[receipt.status], tone: receipt.status === "failed" ? "error" : "muted", running: false });
	}
	return blocks;
}

export interface PresentationInput {
	readonly locale: Locale;
	readonly typography: Typography;
	readonly sessions: readonly Session[];
	readonly workspaces: readonly WorkspaceGrantView[];
	readonly connection?: ClientConnection;
	readonly catalog?: ModelCatalog;
	readonly selection?: SessionModel;
	readonly thinking: string;
	readonly enabledModels: readonly string[] | null;
	readonly connections?: ModelConnectionsLike;
	readonly rosterFilter: string;
	readonly draft: string;
	readonly paletteSelection: number;
	readonly commands: readonly CommandLike[];
	readonly attachments: readonly Attachment[];
	readonly panel: PanelView;
	readonly dock?: DockView;
	readonly mode: SubmitMode;
	readonly usage?: UsageReport;
	readonly welcomeDismissed: boolean;
	readonly newSessionPending: boolean;
	readonly ready: boolean;
}

export function pythonView(input: PresentationInput): WebView {
	const { locale, connection, catalog } = input;
	const snapshot = connection?.snapshot;
	const session = input.sessions.find(item => item.session_id === connection?.sessionId);
	const cwd = input.workspaces.find(item => item.name === session?.workspace)?.host_path ?? "";
	const directory = { sessions: input.sessions.map(item => ({ sessionId: item.session_id, projectId: item.project_id, name: item.title,
		createdAt: item.updated_ms ?? 0, cwd: input.workspaces.find(root => root.name === item.workspace)?.host_path, ...(item.archived ? { archivedAt: item.updated_ms ?? 0 } : {}) })) };
	const selected = input.selection ?? (catalog ? { provider: catalog.current.provider, model: catalog.current.model } : undefined);
	const models: ModelsStateLike | undefined = catalog ? { catalog: { revision: 0, enabledModelIds: input.enabledModels === null ? null : [...input.enabledModels],
		availableModels: catalog.models.map(item => ({ provider: item.provider, modelId: item.model, name: item.label, reasoning: (item.thinking_levels?.length ?? 0) > 1 })) },
		configuration: { model: selected ? { provider: selected.provider, modelId: selected.model } : null, thinkingLevel: input.thinking }, refresh: { status: "idle" } } : undefined;
	const levels = catalog?.models.find(item => item.provider === selected?.provider && item.model === selected.model)?.thinking_levels;
	const pending = snapshot?.requests.filter(item => !settled.has(item.status)) ?? [];
	const approvalState = { pending: (snapshot?.approvals ?? []).filter(item => item.state === "pending").map(item => ({ id: item.approval_id, tool: item.call.name, detail: item.call.arguments })) };
	const approvals = approvalCards(locale, approvalState);
	const base = failureView(locale, "");
	return { ...base, typography: input.typography, modelConnections: input.connections, roster: rosterItems(locale, directory, connection?.sessionId, Date.now(), input.rosterFilter),
		rosterFilter: input.rosterFilter, transcriptScope: connection ? `${connection.identity.profile_id}:${connection.sessionId}` : undefined,
		attachedId: connection?.ready ? connection.sessionId : undefined, sessionLabel: session?.title, readOnly: session?.archived || !connection?.ready || !input.ready || snapshot?.state !== "ready",
		blocks: transcriptBlocks(locale, snapshot), status: snapshot?.state === "ready" ? pending.length ? requestStatus[pending[0].status] : "" : snapshot?.state ?? "",
		queue: pending.filter(item => item.status === "queued" || item.status === "waiting_time").map(item => ({ id: item.request_id, text: item.text,
			cancel: { id: actions.QUEUE_CANCEL_ACTION, data: item.request_id, label: "取消排队", weight: "text" } })),
		attachments: input.attachments, approvals, approvalIndicator: approvalIndicator(locale, approvalState), busy: pending.some(item => item.status !== "queued"),
		welcome: welcomeCard(locale, { show: !input.sessions.length && !input.welcomeDismissed }), newSession: { enabled: input.ready && !input.newSessionPending, pending: input.newSessionPending },
		run: runControls(locale, input.mode, Boolean(connection?.ready), Boolean(snapshot?.requests.some(item => settled.has(item.status)))),
		model: modelPicker(locale, models, levels, connection?.ready === true), panel: input.panel,
		palette: commandPalette(locale, { draft: input.draft, commands: input.commands, selected: input.paletteSelection }),
		shortcuts: shortcuts(locale, typeof navigator === "undefined" ? "" : navigator.platform),
		dock: input.dock ?? dockView(locale, { open: false, tab: "files", cwd, workspace: undefined, terminal: undefined, conversations: undefined }),
		meter: { context: "?", tokens: input.usage ? `${input.usage.input_tokens ?? 0} / ${input.usage.output_tokens ?? 0}` : "? / ?", cost: input.usage?.priced && input.usage.cost_micro_usd !== null && input.usage.cost_micro_usd !== undefined ? `$${(input.usage.cost_micro_usd / 1_000_000).toFixed(3)}` : "?", tone: "neutral" },
	};
}
