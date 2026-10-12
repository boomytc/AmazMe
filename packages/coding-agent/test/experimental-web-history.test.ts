import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { type ConversationId, type EntryId, type EntryRecord, UserEntry } from "@amazme/durable";
import { describe, expect, test, vi } from "vitest";
import type { HistoryPage } from "../src/durable/conversation-view.ts";
import type { Conversations } from "../src/host/services/conversations.ts";
import { HistoryAvailability } from "../src/host/web/history-availability.ts";

const ENTRY: EntryRecord = {
	id: 1 as EntryId,
	conversationId: 1 as ConversationId,
	kind: UserEntry.kind,
	model: [{ role: "user", content: "Older input", timestamp: 1 }],
};

function pendingPage() {
	let resolve!: (page: HistoryPage) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<HistoryPage>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function setup() {
	const pending = pendingPage();
	const older = vi.fn<Conversations["older"]>(() => pending.promise);
	const onChange = vi.fn();
	const onError = vi.fn();
	const availability = new HistoryAvailability(onChange, onError);
	const scope = { service: { older }, sessionId: "session", conversationId: "1", before: "10", revision: 0 };
	return { availability, pending, older, onChange, onError, scope };
}

describe("the page confirms earlier history before offering to load it", () => {
	test("unknown and exhausted history stay hidden, with one bounded probe per scope", async () => {
		const { availability, pending, older, onChange, onError, scope } = setup();
		expect(availability.update(undefined)).toBe(false);
		expect(older).not.toHaveBeenCalled();
		expect(availability.update(scope)).toBe(false);
		expect(availability.update({ ...scope })).toBe(false);
		expect(older).toHaveBeenCalledTimes(1);
		expect(older).toHaveBeenCalledWith("1", "10", null, 1, BACKGROUND_CONTEXT);
		pending.resolve({ entries: [] });
		await pending.promise;
		expect(availability.update(scope)).toBe(false);
		expect(older).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	test("a real older entry enables loading even when there is no further cursor", async () => {
		const { availability, pending, older, onChange, scope } = setup();
		expect(availability.update(scope)).toBe(false);
		pending.resolve({ entries: [ENTRY] });
		await pending.promise;
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(availability.update(scope)).toBe(true);
		expect(older).toHaveBeenCalledTimes(1);
	});

	test.each(["session", "conversation", "boundary", "revision", "binding"] as const)(
		"rechecks a changed %s and ignores the previous response", async (change) => {
			const { availability, pending, older, onChange, scope } = setup();
			availability.update(scope);
			const next = pendingPage();
			older.mockImplementation(() => next.promise);
			const nextScope = change === "session" ? { ...scope, sessionId: "other" }
				: change === "conversation" ? { ...scope, conversationId: "2" }
				: change === "boundary" ? { ...scope, before: "20" }
				: change === "revision" ? { ...scope, revision: 1 }
				: { ...scope, service: { older: vi.fn<Conversations["older"]>(() => next.promise) } };
			expect(availability.update(nextScope)).toBe(false);
			pending.resolve({ entries: [ENTRY] });
			await pending.promise;
			expect(onChange).not.toHaveBeenCalled();
			expect(availability.update(nextScope)).toBe(false);
			next.resolve({ entries: [ENTRY] });
			await next.promise;
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(availability.update(nextScope)).toBe(true);
		},
	);

	test("a detach or explicit page load cancels an in-flight availability result", async () => {
		const { availability, pending, onChange, onError, scope } = setup();
		availability.update(scope);
		expect(availability.update(undefined)).toBe(false);
		pending.resolve({ entries: [ENTRY] });
		await pending.promise;
		expect(onChange).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	test("an unsuccessful probe reports its error without claiming there is more history", async () => {
		const { availability, pending, older, onChange, onError, scope } = setup();
		availability.update(scope);
		const error = new Error("History lookup failed");
		pending.reject(error);
		await expect(pending.promise).rejects.toBe(error);
		expect(onError).toHaveBeenCalledWith(error);
		expect(onChange).not.toHaveBeenCalled();
		expect(availability.update(scope)).toBe(false);
		expect(older).toHaveBeenCalledTimes(1);
	});

	test("a stale probe error does not interrupt the new conversation", async () => {
		const { availability, pending, onError, scope } = setup();
		availability.update(scope);
		availability.update(undefined);
		const error = new Error("Old connection closed");
		pending.reject(error);
		await expect(pending.promise).rejects.toBe(error);
		expect(onError).not.toHaveBeenCalled();
	});
});
