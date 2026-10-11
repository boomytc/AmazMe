import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { type Context, defineFacet } from "@amazme/chord";
import { LiveDoc } from "@amazme/durable";
import type { ConversationId, Harness } from "@amazme/durable";
import type { AgentOperationError } from "../../core/plugins/agent-controller.ts";
import { ContextCleanupDoc, ReviewDoc, RunStateDoc } from "../../durable/insights/state.ts";
import { resumeRun } from "../../durable/insights/run-policy.ts";
import { readReview, refreshReview } from "../../durable/insights/workspace-review.ts";
import { Conversations } from "./conversations.ts";
import { SessionInsights, type SessionInsightsState } from "./insights.ts";

export function createInsightsFacet(harness: Harness, root: ConversationId, admission?: (context: Context) => Promise<AgentOperationError | undefined>) {
	return defineFacet({ id: "@amazme/session-insights", setup(env) {
		const conversations = env.use(Conversations);
		const selected = (): ConversationId => Number(conversations.state.value?.selected ?? root) as ConversationId;
		const state = env.replicatedState<SessionInsightsState>({ revision: 0, reviewRevision: 0, conversationId: String(root), paused: null, calls: 0, cleanup: { tools: 0, images: 0 }, files: [], notes: [], skipped: 0, at: 0, verification: [] });
		let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, sequence = 0;
		const publish = async (context: Context): Promise<void> => {
			const request = ++sequence, id = selected();
			const [review, policy, cleanup, live] = await Promise.all([readReview(harness, id, context), harness.snapshot(RunStateDoc, id, context), harness.snapshot(ContextCleanupDoc, id, context), harness.snapshot(LiveDoc, id, context)]);
			if (disposed || request !== sequence || selected() !== id) return;
			state.change(context, draft => {
				draft.revision++; draft.conversationId = String(id);
				draft.reviewRevision = review.state?.revision ?? 0;
				draft.paused = live?.run && policy?.run === String(live.run.inputs[0]) ? policy.paused : null;
				draft.calls = policy?.calls ?? 0;
				draft.cleanup = { tools: cleanup?.decisions.filter(item => item.kind === "tool").length ?? 0, images: cleanup?.decisions.filter(item => item.kind === "image").length ?? 0 };
				draft.files = review.files.map(({ diff: _diff, ...file }) => file);
				draft.notes = [...review.state?.notes ?? []]; draft.skipped = review.state?.skipped ?? 0; draft.at = review.state?.at ?? 0;
				draft.verification = [...review.state?.verification ?? []];
			});
		};
		const schedule = (): void => { if (timer || disposed) return; timer = setTimeout(() => { timer = undefined; void publish(BACKGROUND_CONTEXT).catch(() => {}); }, 60); };
		env.provide(SessionInsights, {
			state,
			async refresh(context) { await refreshReview(harness, selected(), context); await publish(context); },
			async diff(conversationId, root, path, context) {
				if (String(selected()) !== conversationId) throw new Error("对话已切换，请重新选择文件。");
				const review = await readReview(harness, selected(), context);
				return review.files.find(file => file.root === root && file.path === path)?.diff ?? "这个文件已不在本轮变更中。";
			},
			async resume(conversationId, context) {
				const target = selected();
				if (String(target) !== conversationId) throw new Error("对话已切换，请重新选择任务。");
				const error = await admission?.(context); if (error) throw new Error(error.message);
				if (selected() !== target) throw new Error("对话已切换，请重新选择任务。");
				await resumeRun(harness, target, context); await publish(context);
			},
		});
		env.onActivate(async () => {
			env.own(conversations.state.subscribe(() => { if (state.value.conversationId !== String(selected())) schedule(); }));
			await publish(BACKGROUND_CONTEXT);
		});
		const relevant = new Set([RunStateDoc.definition.kind, ReviewDoc.definition.kind, ContextCleanupDoc.definition.kind]);
		env.own(harness.subscribeCommits(publication => {
			if (publication.changes.some(change => change.type === "document" && (relevant.has(change.record.kind)
				|| (change.record.kind === LiveDoc.definition.kind && (change.ops.length === 0 || change.ops.some(op => Array.isArray(op[1]) && op[1][0] === "run")))))) schedule();
		}));
		env.own(() => { disposed = true; sequence++; if (timer) clearTimeout(timer); });
	} });
}
