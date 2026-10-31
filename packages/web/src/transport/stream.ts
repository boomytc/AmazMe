import type { Attachment, Preview, Receipt, Snapshot, Stream } from "../generated/contracts.ts";
import { isRecord, parseContract } from "./api.ts";

export const settled = new Set<Receipt["status"]>(["succeeded", "cancelled", "interrupted", "failed", "unknown"]);
export const requestStatus: Readonly<Record<Receipt["status"], string>> = {
	queued: "等待执行", running: "执行中", waiting_approval: "等待审批", waiting_input: "等待回答", waiting_children: "等待子任务", waiting_time: "等待计划时间", waiting_host: "等待恢复",
	cancelling: "正在清理", cleaning: "正在清理", blocked: "等待清理", succeeded: "已完成", cancelled: "已取消", interrupted: "运行中断", failed: "失败", unknown: "结果未知，未自动重试",
};

export function seq(value: string | undefined): bigint {
	if (!value || !/^(0|[1-9][0-9]{0,17})$/.test(value)) throw new Error("无效的事务序号");
	return BigInt(value);
}

function upsert<T, K extends keyof T>(items: T[], item: T, key: K): void {
	const index = items.findIndex(old => old[key] === item[key]);
	if (index < 0) items.push(item); else items[index] = item;
}

function previewMatches(preview: Preview, receipt: Receipt | undefined): boolean {
	return receipt !== undefined && !receipt.decision && !settled.has(receipt.status) && preview.run_id === receipt.run_id && preview.generation === receipt.generation;
}

/** Bound incremental presentation history; snapshots preserve every outstanding obligation. */
function trim(model: Snapshot): Snapshot {
	const held = new Set((model.effects ?? []).filter(effect => !effect.reconciled || !effect.resource_clean).map(effect => effect.request_id));
	const done = model.requests.filter(row => settled.has(row.status)).sort((a, b) => seq(a.revision) < seq(b.revision) ? -1 : seq(a.revision) > seq(b.revision) ? 1 : 0);
	const keep = new Set(done.filter(row => row.kind === "root" && row.text).slice(-20).map(row => row.request_id));
	for (const row of done.filter(row => row.kind === "root" && !row.text).slice(-20)) keep.add(row.request_id);
	let bytes = 0;
	for (const row of done.filter(row => row.kind !== "root").slice(-20).reverse()) {
		if (held.has(row.request_id)) continue;
		const size = new TextEncoder().encode(JSON.stringify(row)).length;
		if (bytes + size > 512 * 1024) continue;
		bytes += size; keep.add(row.request_id);
	}
	model.requests = model.requests.filter(row => !settled.has(row.status) || keep.has(row.request_id) || held.has(row.request_id));
	const ids = new Set(model.requests.map(row => row.request_id));
	model.approvals = (model.approvals ?? []).filter(item => ids.has(item.request_id) || item.state === "pending");
	model.questions = (model.questions ?? []).filter(question => question.state === "pending"
		&& model.requests.some(request => request.request_id === question.request_id && request.status === "waiting_input" && !request.cancel_requested && !request.decision));
	model.previews = (model.previews ?? []).filter(item => previewMatches(item, model.requests.find(row => row.request_id === item.request_id)));
	model.events = model.events.slice(-200);
	return model;
}

/** Reject an entire malformed transaction before either the rendered state or ACK advances. */
export function applyFrame(previous: Snapshot | undefined, frame: Stream, binding: Attachment): Snapshot {
	if (frame.binding_id !== binding.attachment_id || frame.build_id !== binding.build_id || !frame.stream_id) throw new Error("事件绑定或协议不匹配");
	const batches = frame.batches ?? [];
	if (frame.snapshot) {
		const snapshot = frame.snapshot;
		if (batches.length || snapshot.session_id !== binding.session_id || snapshot.stream_id !== frame.stream_id) throw new Error("快照身份不匹配");
		seq(snapshot.seq);
		if (previous?.stream_id === snapshot.stream_id && seq(snapshot.seq) < seq(previous.seq)) throw new Error("快照水位倒退");
		for (const preview of snapshot.previews ?? []) seq(preview.preview_seq);
		return structuredClone(snapshot);
	}
	if (!previous || frame.resync || frame.stream_id !== previous.stream_id || !batches.length || batches.length > 16) throw new Error("需要重新同步快照");
	const model = structuredClone(previous);
	let cursor = seq(model.seq), last: bigint | undefined;
	model.approvals ??= []; model.previews ??= []; model.effects ??= []; model.questions ??= [];
	for (const batch of batches) {
		const number = seq(batch.seq);
		if (batch.stream_id !== model.stream_id || seq(batch.revision) !== number || seq(batch.base_revision) !== number - 1n || !batch.events.length ||
			batch.events.some(event => event.seq !== batch.seq) || (last !== undefined && number !== last + 1n)) throw new Error("事务批次不完整或顺序错误");
		last = number;
		if (number <= cursor) continue;
		if (number !== cursor + 1n || seq(batch.base_revision) !== seq(model.seq)) throw new Error("事务存在缺口，正在重新同步");
		for (const event of batch.events) {
			if (event.receipt) {
				if (event.receipt.request_id !== event.request_id || event.receipt.revision !== batch.revision) throw new Error("回执与事务不匹配");
				upsert(model.requests, event.receipt, "request_id");
			}
			if (event.approval) upsert(model.approvals, event.approval, "approval_id");
			if (event.question) {
				if (event.question.request_id !== event.request_id) throw new Error("问题与事务归属不匹配");
				upsert(model.questions, event.question, "question_id");
			}
			if (event.preview) {
				const preview = event.preview;
				seq(preview.preview_seq);
				const receipt = model.requests.find(row => row.request_id === preview.request_id);
				const old = model.previews.find(item => item.request_id === preview.request_id);
				if (previewMatches(preview, receipt) && (!old || old.generation !== preview.generation || old.run_id !== preview.run_id || seq(preview.preview_seq) > seq(old.preview_seq))) upsert(model.previews, preview, "request_id");
			}
			if (event.kind === "message" && event.message) {
				model.previews = model.previews.filter(item => item.request_id !== event.request_id);
				model.events = model.events.filter(old => old.kind !== "message" || old.request_id !== event.request_id || old.message?.key !== event.message?.key);
				model.events.push(event);
			}
			if (event.kind === "effect") {
				const value: unknown = JSON.parse(event.text);
				if (isRecord(value) && typeof value.resource_clean === "boolean" && value.session_id === binding.session_id) upsert(model.effects, parseContract("EffectHold", value), "call_id");
			}
			if (event.kind === "cleanup") {
				try {
					const proof: unknown = JSON.parse(event.text);
					if (isRecord(proof)) {
						if (proof.state === "blocked") model.state = "blocked";
						if (proof.state === "clean" && typeof proof.proof_id === "string" && proof.proof_id && proof.session_id === binding.session_id)
							for (const effect of model.effects) if (effect.request_id === event.request_id) effect.resource_clean = true;
					}
				} catch { /* Textual diagnostics are retained in the execution record. */ }
			}
			if (event.kind === "status" && event.text.startsWith("blocked:")) model.state = "blocked";
			if (event.kind === "status" && event.text === "stopping") model.state = "stopping";
			if (event.kind === "freeze") model.state = event.text.startsWith("thawed:") ? "ready" : "frozen";
			if (["tool", "cleanup", "effect", "children"].includes(event.kind)) model.events.push(event);
		}
		model.seq = batch.seq; cursor = number;
	}
	const pending = new Set(model.requests.filter(row => !settled.has(row.status)).map(row => row.request_id));
	for (const effect of model.effects) if ((!effect.reconciled || !effect.resource_clean) && effect.request_id) pending.add(effect.request_id);
	model.pending = pending.size;
	const wakes = model.requests.filter(row => row.status === "waiting_time" && row.not_before_ms).map(row => row.not_before_ms ?? 0);
	model.next_wake_ms = wakes.length ? Math.min(...wakes) : 0;
	return trim(model);
}
