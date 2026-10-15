import type { ClassifierContext } from "../types.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown, at: string, ancestors = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object" || value === null) throw new Error(`${at} must contain only JSON values`);
	if (ancestors.has(value)) throw new Error(`${at} must not contain cycles`);
	if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
		throw new Error(`${at} must contain only JSON objects`);
	}
	ancestors.add(value);
	for (const [key, child] of Object.entries(value)) json(child, `${at}.${key}`, ancestors);
	ancestors.delete(value);
}

function content(value: unknown, at: string): void {
	if (value !== null && typeof value !== "string" && typeof value !== "object") {
		throw new Error(`${at} must be a string, object, array, or null`);
	}
	json(value, at);
}

function image(value: unknown, at: string): void {
	if (
		!record(value) ||
		value.type !== "image" ||
		typeof value.data !== "string" ||
		typeof value.mimeType !== "string"
	) {
		throw new Error(`${at} must be an image block`);
	}
}

/** Validates JSON-safe classifier input at host and sandbox boundaries without changing it. */
export function assertClassifierContext(value: unknown): asserts value is ClassifierContext {
	if (!record(value)) throw new Error("expects a context object as its second argument");
	if (!record(value.state)) throw new Error("context.state must be an object");
	json(value.state, "context.state");
	if (value.images !== undefined) {
		if (!Array.isArray(value.images)) throw new Error("context.images must be an array");
		value.images.forEach((entry, index) => image(entry, `context.images[${index}]`));
	}
	if (value.assets !== undefined) {
		if (!record(value.assets)) throw new Error("context.assets must map references to image blocks");
		for (const [reference, asset] of Object.entries(value.assets)) image(asset, `context.assets.${reference}`);
	}
	if (!record(value.questions) || Object.keys(value.questions).length === 0) {
		throw new Error("context.questions must map question IDs to questions");
	}
	for (const [id, question] of Object.entries(value.questions)) {
		const at = `context.questions.${id}`;
		if (!record(question)) throw new Error(`${at} must be a question object`);
		content(question.instructions, `${at}.instructions`);
		if (question.type === "choice") {
			if (!record(question.criteria) || Object.keys(question.criteria).length === 0) {
				throw new Error(`${at} is a "choice" question, so criteria must map each label to its meaning`);
			}
			for (const [key, entry] of Object.entries(question.criteria)) content(entry, `${at}.criteria.${key}`);
		} else if (question.type === "score") {
			if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
				throw new Error(`${at} is a "score" question, so criteria must list levels, lowest first`);
			}
			question.criteria.forEach((entry, index) => content(entry, `${at}.criteria[${index}]`));
		} else if (question.type === "bool") {
			if (
				!record(question.criteria) ||
				!Object.hasOwn(question.criteria, "true") ||
				!Object.hasOwn(question.criteria, "false")
			) {
				throw new Error(`${at} is a "bool" question, so criteria must define true and false`);
			}
			content(question.criteria.true, `${at}.criteria.true`);
			content(question.criteria.false, `${at}.criteria.false`);
		} else if (question.type === "box") {
			if (question.criteria !== undefined) throw new Error(`${at} is a "box" question, so it must not have criteria`);
		} else {
			throw new Error(`${at}.type must be "choice", "score", "bool", or "box", got ${JSON.stringify(question.type)}`);
		}
	}
}
