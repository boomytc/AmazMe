import * as actions from "./actions.ts";
import { commandPalette, type CommandLike } from "./commands.ts";
import { dockView, type DockView } from "./dock.ts";
import type { Locale } from "./locale.ts";
import type { ApprovalPolicy } from "./permission-picker.ts";
import type { ModelConnectionsLike } from "./model-connections.ts";
import type { PanelView } from "./panels.ts";
import { projectGroups } from "./projects.ts";
import { isRecord } from "./python-api.ts";
import type { ClientConnection } from "./python-client.ts";
import type { AnswerFeedbackList, HistoryPage, ModelCatalog, ProjectView, Session, SessionModel, Snapshot, TranscriptMessage, UsageReport, WorkspaceGrantView } from "./python-contracts.ts";
import { requestStatus, seq, settled } from "./python-stream.ts";
import { shortcuts } from "./shortcuts.ts";
import { translate } from "./strings.ts";
import { collapsedToolArgs, expandedToolArgs } from "./tool-args.ts";
import { toolResultView } from "./tool-results.ts";
import type { Typography } from "./typography.ts";
import { approvalCards, approvalIndicator, failureView, feedbackControls, modelPicker, rosterItems, runControls, welcomeCard, type Attachment, type ModelsStateLike, type SessionDirectoryLike, type SubmitMode, type TranscriptBlock, type WebView } from "./view.ts";

/** Project only the host's committed receipts and generation-matched previews. */
export function transcriptBlocks(locale: Locale, snapshot: Snapshot | undefined, feedback?: AnswerFeedbackList): TranscriptBlock[] {
	if (!snapshot) return [];
	const blocks: TranscriptBlock[] = [];
	for (const receipt of snapshot.requests) {
		const rating = feedback?.session_id === snapshot.session_id ? feedback.records?.find(item => item.request_id === receipt.request_id) : undefined;
		const controls = feedback?.session_id === snapshot.session_id && receipt.kind === "root" && receipt.status === "succeeded" && receipt.answer ? feedbackControls(locale, JSON.stringify([snapshot.session_id, receipt.request_id, rating?.rating ?? null, rating?.revision ?? 0]), rating?.rating ?? null) : undefined;
		if (receipt.text || receipt.image_count) blocks.push({ id: `${receipt.request_id}:user`, kind: "user", title: locale === "zh" ? "你" : "You", text: receipt.text, tone: "plain", running: false,
			images: Array.from({ length: receipt.image_count ?? 0 }, (_, index) => ({ dataUrl: `/api/v1/sessions/${encodeURIComponent(snapshot.session_id)}/requests/${encodeURIComponent(receipt.request_id)}/images/${index}`, alt: `${locale === "zh" ? "图片" : "Image"} ${index + 1}` })) });
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
		const messages = new Map<string, TranscriptMessage>();
		for (const event of snapshot.events) if (event.request_id === receipt.request_id && event.kind === "message" && event.message) messages.set(event.message.key, event.message);
		let finalMessage = false;
		for (const message of [...messages.values()].sort((a, b) => a.ordinal - b.ordinal)) {
			if (message.key === "compaction" || message.key.startsWith("history:")) continue;
			if (message.role === "assistant") {
				if (message.content) blocks.push({ id: `${receipt.request_id}:message:${message.key}`, kind: "assistant", title: "AmazMe", text: message.content, tone: "plain", running: false, ...(!message.tool_calls?.length ? { feedback: controls } : {}) });
				if (!message.tool_calls?.length) finalMessage = true;
				for (const call of message.tool_calls ?? []) {
					const block = tools.get(call);
					if (block) { blocks.push(block); tools.delete(call); }
				}
			}
		}
		blocks.push(...tools.values());
		const preview = snapshot.previews?.find(item => item.request_id === receipt.request_id && item.run_id === receipt.run_id && item.generation === receipt.generation);
		const text = !settled.has(receipt.status) && preview?.text ? preview.text : !finalMessage ? receipt.answer : undefined;
		if (text) blocks.push({ id: `${receipt.request_id}:answer`, kind: "assistant", title: "AmazMe", text, tone: "plain", running: !settled.has(receipt.status), interrupted: receipt.status === "interrupted" || receipt.status === "cancelled", feedback: controls });
		if (receipt.error || ["failed", "unknown", "interrupted", "cancelled"].includes(receipt.status)) blocks.push({ id: `${receipt.request_id}:status`, kind: "notice", title: requestStatus[receipt.status], text: receipt.error ?? requestStatus[receipt.status], tone: receipt.status === "failed" ? "error" : "muted", running: false });
	}
	return blocks;
}

export interface PresentationInput {
	readonly locale: Locale;
	readonly typography: Typography;
	readonly sessions: readonly Session[];
	readonly projects?: readonly ProjectView[];
	readonly selectedProject?: string;
	readonly expandedProjects?: readonly string[];
	readonly workspaces: readonly WorkspaceGrantView[];
	readonly connection?: ClientConnection;
	readonly catalog?: ModelCatalog;
	readonly selection?: SessionModel;
	readonly thinking: string;
	readonly approvalPolicy?: ApprovalPolicy;
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
	readonly history?: HistoryPage;
	readonly feedback?: AnswerFeedbackList;
	readonly historyMore?: boolean;
	readonly historyLoading?: boolean;
	readonly welcomeDismissed: boolean;
	readonly newSessionPending: boolean;
	readonly ready: boolean;
}

export function pythonView(input: PresentationInput): WebView {
	const { locale, connection, catalog } = input;
	const snapshot = connection?.snapshot;
	const session = input.sessions.find(item => item.session_id === connection?.sessionId);
	const cwd = input.workspaces.find(item => item.name === session?.workspace)?.host_path ?? "";
	const directory = pythonDirectory(input.sessions, input.projects ?? [], input.workspaces);
	const roster = rosterItems(locale, directory, connection?.sessionId, Date.now(), input.rosterFilter);
	const selected = input.selection ?? (catalog ? { provider: catalog.current.provider, model: catalog.current.model } : undefined);
	const availableProviders = new Set(input.connections?.state.providers.filter(provider => provider.available).map(provider => provider.id));
	const enabledModelIds = (input.connections?.enabledModels ?? []).map(model => `${model.provider}/${model.modelId}`)
		.filter(id => input.enabledModels === null || input.enabledModels.includes(id));
	const models: ModelsStateLike | undefined = catalog ? { catalog: { revision: 0, enabledModelIds,
		availableModels: catalog.models.filter(item => availableProviders.has(item.provider)).map(item => ({ provider: item.provider, modelId: item.model, name: item.label, reasoning: (item.thinking_levels?.length ?? 0) > 1 })) },
		configuration: { model: selected ? { provider: selected.provider, modelId: selected.model } : null, thinkingLevel: input.thinking }, refresh: { status: "idle" } } : undefined;
	const levels = catalog?.models.find(item => item.provider === selected?.provider && item.model === selected.model)?.thinking_levels;
	const pending = snapshot?.requests.filter(item => !settled.has(item.status)) ?? [];
	const approvalState = { pending: (snapshot?.approvals ?? []).filter(item => item.state === "pending").map(item => ({ id: item.approval_id, tool: item.call.name, detail: item.call.arguments })) };
	const approvals = approvalCards(locale, approvalState);
	const base = failureView(locale, "");
	return { ...base, typography: input.typography, modelConnections: input.connections, roster, approvalPolicy: input.approvalPolicy,
		projects: projectGroups(directory, roster, input.selectedProject, input.rosterFilter, input.expandedProjects),
		archivedAttached: session?.archived ? rosterItems(locale, directory, connection?.sessionId, Date.now(), "", true).find(item => item.id === connection?.sessionId) : undefined,
		rosterFilter: input.rosterFilter, transcriptScope: connection ? `${connection.identity.profile_id}:${connection.sessionId}` : undefined,
		attachedId: connection?.ready ? connection.sessionId : undefined, sessionLabel: session?.title, readOnly: session?.archived || !connection?.ready || !input.ready || snapshot?.state !== "ready",
		blocks: [...(input.history?.truncated ? [{ id: "history:truncated", kind: "notice" as const, title: locale === "zh" ? "历史记录" : "History", text: locale === "zh" ? "部分工具输出超过展示上限；原始记录仍保存在本机。" : "Some tool output exceeds the display limit. Original records remain stored locally.", tone: "muted" as const, running: false }] : []), ...transcriptBlocks(locale, withHistory(snapshot, input.history), input.feedback)], history: { blocks: [], more: input.historyMore ?? false, loading: input.historyLoading ?? false }, status: snapshot?.state === "ready" ? pending.length ? requestStatus[pending[0].status] : "" : snapshot?.state ?? "",
		queue: [...pending.filter(item => item.status === "queued" || item.status === "waiting_time").map(item => ({ id: item.request_id, text: item.text,
			cancel: { id: actions.QUEUE_CANCEL_ACTION, data: item.request_id, label: "取消排队", weight: "text" as const } })),
			...(snapshot?.effects ?? []).filter(item => !item.reconciled).map(item => ({ id: `effect:${item.call_id}`, text: `${item.resource_clean ? "未知副作用待核对" : "等待资源退出后核对"}：${item.reason}`,
				retry: { id: item.reason === "codemode_outcome_unknown" && !item.resource_clean ? "effect:cleanup" : "effect:review", data: JSON.stringify([snapshot?.session_id, item.call_id]), label: item.reason === "codemode_outcome_unknown" && !item.resource_clean ? "核对脚本退出" : "核对执行效果", weight: "line" as const, disabled: !connection?.ready || !item.resource_clean && item.reason !== "codemode_outcome_unknown" } }))],
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

/** A display cache never changes the live snapshot used for admissions, cancellation or ACK. */
function withHistory(snapshot: Snapshot | undefined, history: HistoryPage | undefined): Snapshot | undefined {
	if (!snapshot || !history || snapshot.session_id !== history.session_id) return snapshot;
	const rows = new Map(history.requests.map(row => [row.request_id, row]));
	for (const row of snapshot.requests) {
		const older = rows.get(row.request_id);
		if (!older || seq(row.revision ?? "0") >= seq(older.revision ?? "0")) rows.set(row.request_id, row);
	}
	return { ...snapshot, requests: [...rows.values()].sort((a, b) => seq(a.accepted_revision ?? "0") < seq(b.accepted_revision ?? "0") ? -1 : seq(a.accepted_revision ?? "0") > seq(b.accepted_revision ?? "0") ? 1 : 0), events: [...history.events, ...snapshot.events].sort((a, b) => seq(a.seq) < seq(b.seq) ? -1 : seq(a.seq) > seq(b.seq) ? 1 : 0) };
}

export function pythonDirectory(sessions: readonly Session[], projects: readonly ProjectView[], workspaces: readonly WorkspaceGrantView[]): SessionDirectoryLike {
	return { sessions: sessions.map(item => ({ sessionId: item.session_id, projectId: item.project_id || undefined, name: item.title,
		createdAt: item.updated_ms ?? 0, cwd: workspaces.find(root => root.name === (item.workspace ?? "primary"))?.host_path, ...(item.archived ? { archivedAt: item.updated_ms ?? 0 } : {}) })),
		projects: projects.map(item => { const paths = (item.workspaces ?? ["primary"]).map(name => workspaces.find(root => root.name === name)?.host_path ?? name); return { id: item.project_id, name: item.name, cwd: paths[0] ?? "", workspaces: paths, createdAt: 0, revision: item.revision, ...(item.removed ? { removed: true as const } : {}) }; }),
	};
}
