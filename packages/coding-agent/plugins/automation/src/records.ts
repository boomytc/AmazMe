import type { ScheduleRecord, ScheduleRun, ScheduleRunReceipt } from "@amazme/coding-agent/plugin";

export const MAX_SCHEDULE_TIME = 8_640_000_000_000_000;
export const SCHEDULE_MAX_PROMPT = 8_000;

export function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCHEDULE_TIME;
}

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
		!(record.scheduledFor === null || timestamp(record.scheduledFor)) ||
		typeof record.cancelling !== "boolean" ||
		!(record.problem === null || typeof record.problem === "string")
	)
		return undefined;
	return {
		requestId: record.requestId,
		operationId: record.operationId,
		startedAt: record.startedAt,
		scheduledFor: record.scheduledFor,
		cancelling: record.cancelling,
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
		typeof record.note !== "string" ||
		!(
			record.status === "done" ||
			record.status === "unanswered" ||
			record.status === "refused" ||
			record.status === "cancelled"
		)
	)
		return undefined;
	return {
		requestId: record.requestId,
		operationId: record.operationId,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		status: record.status,
		note: record.note,
	};
}

/** Invalid or incomplete targets are read-only; never infer a conversation from today's focus. */
export function parseSchedule(value: unknown): ScheduleRecord | undefined {
	const record = object(value);
	if (
		record === undefined ||
		!text(record.id) ||
		!text(record.sessionId) ||
		!conversationId(record.conversationId) ||
		!text(record.prompt) ||
		record.prompt.trim().length === 0 ||
		record.prompt.length > SCHEDULE_MAX_PROMPT ||
		typeof record.everyMs !== "number" ||
		!Number.isSafeInteger(record.everyMs) ||
		record.everyMs < 60_000 ||
		typeof record.enabled !== "boolean" ||
		!timestamp(record.createdAt) ||
		!timestamp(record.nextRunAt) ||
		!(record.lastRunAt === null || timestamp(record.lastRunAt)) ||
		!(record.lastOutcome === null || typeof record.lastOutcome === "string") ||
		!Array.isArray(record.history) ||
		record.history.length > 20
	)
		return undefined;
	const run = pending(record.pending);
	const history = record.history.map(receipt);
	if (run === undefined || history.some((entry) => entry === undefined)) return undefined;
	return {
		id: record.id,
		sessionId: record.sessionId,
		conversationId: record.conversationId,
		prompt: record.prompt,
		everyMs: record.everyMs,
		enabled: record.enabled,
		createdAt: record.createdAt,
		lastRunAt: record.lastRunAt,
		lastOutcome: record.lastOutcome,
		nextRunAt: record.nextRunAt,
		pending: run,
		history: history as ScheduleRunReceipt[],
	};
}
