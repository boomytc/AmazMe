import type { ScheduleRecord, ScheduleRun, ScheduleRunReceipt } from "@amazme/coding-agent/plugin";

import { MAX_GRACE_MINUTES, MAX_TIMEOUT_SECONDS, normalizeRule, timestamp } from "./rules.ts";
export const SCHEDULE_MAX_PROMPT = 8_000;

export function conversationId(value: unknown): value is string {
	return typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
function operationId(value: unknown): value is string | null {
	return value === null || conversationId(value);
}

function pending(value: unknown): ScheduleRun | null | undefined {
	if (value === null) return null;
	const record = object(value);
	if (
		record === undefined ||
		!text(record.requestId) ||
		!operationId(record.operationId) ||
		!timestamp(record.startedAt) ||
		!timestamp(record.deadlineAt) ||
		record.deadlineAt < record.startedAt ||
		record.deadlineAt - record.startedAt > MAX_TIMEOUT_SECONDS * 1_000 ||
		!(record.scheduledFor === null || timestamp(record.scheduledFor)) ||
		!(record.cancelReason === null || record.cancelReason === "cancelled" || record.cancelReason === "timed_out") ||
		!(record.problem === null || typeof record.problem === "string")
	)
		return undefined;
	return {
		requestId: record.requestId,
		operationId: record.operationId,
		startedAt: record.startedAt,
		deadlineAt: record.deadlineAt,
		scheduledFor: record.scheduledFor,
		cancelReason: record.cancelReason,
		problem: record.problem,
	};
}

function receipt(value: unknown): ScheduleRunReceipt | undefined {
	const record = object(value);
	if (
		record === undefined ||
		!text(record.requestId) ||
		!operationId(record.operationId) ||
		!timestamp(record.startedAt) ||
		!timestamp(record.finishedAt) ||
		!(record.detail === null || typeof record.detail === "string") ||
		!(record.scheduledFor === null || timestamp(record.scheduledFor)) ||
		!(
			record.status === "done" ||
			record.status === "unanswered" ||
			record.status === "refused" ||
			record.status === "cancelled" ||
			record.status === "timed_out" ||
			record.status === "skipped"
		)
	)
		return undefined;
	return {
		requestId: record.requestId,
		operationId: record.operationId,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		status: record.status,
		detail: record.detail,
		scheduledFor: record.scheduledFor,
	};
}

export function policy(value: Record<string, unknown>): boolean {
	return (
		(value.busy === "queue" || value.busy === "skip") &&
		(value.missed === "latest" || value.missed === "skip") &&
		typeof value.graceMinutes === "number" &&
		Number.isInteger(value.graceMinutes) &&
		value.graceMinutes >= 0 &&
		value.graceMinutes <= MAX_GRACE_MINUTES &&
		typeof value.timeoutSeconds === "number" &&
		Number.isInteger(value.timeoutSeconds) &&
		value.timeoutSeconds >= 1 &&
		value.timeoutSeconds <= MAX_TIMEOUT_SECONDS
	);
}

/** Invalid targets or rules stay read-only; never infer a destination from today's focus. */
export function parseSchedule(value: unknown): ScheduleRecord | undefined {
	const record = object(value);
	if (
		record === undefined ||
		!text(record.id) ||
		record.id.length > 256 ||
		typeof record.generation !== "number" ||
		!Number.isSafeInteger(record.generation) ||
		record.generation < 1 ||
		!text(record.sessionId) ||
		!conversationId(record.conversationId) ||
		!text(record.prompt) ||
		record.prompt.trim().length === 0 ||
		record.prompt.length > SCHEDULE_MAX_PROMPT ||
		!policy(record) ||
		typeof record.enabled !== "boolean" ||
		!timestamp(record.createdAt) ||
		!(record.nextRunAt === null || timestamp(record.nextRunAt)) ||
		(record.enabled && record.nextRunAt === null) ||
		!Array.isArray(record.history) ||
		record.history.length > 20
	)
		return undefined;
	const run = pending(record.pending);
	const history = record.history.map(receipt);
	if (run === undefined || history.some((entry) => entry === undefined)) return undefined;
	try {
		return {
			id: record.id,
			generation: record.generation,
			sessionId: record.sessionId,
			conversationId: record.conversationId,
			prompt: record.prompt,
			rule: normalizeRule(record.rule),
			busy: record.busy as ScheduleRecord["busy"],
			missed: record.missed as ScheduleRecord["missed"],
			graceMinutes: record.graceMinutes as number,
			timeoutSeconds: record.timeoutSeconds as number,
			enabled: record.enabled,
			createdAt: record.createdAt,
			nextRunAt: record.nextRunAt,
			pending: run,
			history: history as ScheduleRunReceipt[],
		};
	} catch {
		return undefined;
	}
}
