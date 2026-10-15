import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazyApi, lazyStream } from "../src/api/lazy.ts";
import { createModels, createProvider, type ModelsSimpleStreamOptions } from "../src/models.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import type { AssistantMessageEvent, ProviderStreams, SimpleStreamOptions } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const model = fauxProvider().provider.getModels()[0]!;
const context = { messages: [] };

/** Both next and return can ignore the provider signal, as an abandoned body read can. */
class PendingStream extends AssistantMessageEventStream {
	readonly demands: Array<ReturnType<typeof Promise.withResolvers<IteratorResult<AssistantMessageEvent>>>> = [];
	readonly cleanup = vi.fn(() => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}));
	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return {
			next: () => {
				const demand = Promise.withResolvers<IteratorResult<AssistantMessageEvent>>();
				this.demands.push(demand);
				return demand.promise;
			},
			return: this.cleanup,
		};
	}
	pushDemand(event: AssistantMessageEvent): void {
		this.demands.at(-1)!.resolve({ done: false, value: event });
	}
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function collection(source: AssistantMessageEventStream, nested = false) {
	let received: SimpleStreamOptions | undefined;
	const respond: ProviderStreams["streamSimple"] = (_model, _context, options) => {
		received = options;
		return source;
	};
	const api: ProviderStreams = { stream: respond, streamSimple: respond,
		fetchDeferred: (requestModel, _handle, options) => respond(requestModel, { messages: [] }, options) };
	const models = createModels();
	models.setProvider(createProvider({
		id: model.provider, models: [model],
		auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
		api: nested ? lazyApi(async () => api, { fetchDeferred: true }) : api,
	}));
	return { models, received: () => received };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded model streams", () => {
	it.each(["stream", "simple", "deferred"] as const)("bounds %s and strips its local idle option before provider dispatch", async (kind) => {
		const source = new PendingStream();
		const fixture = collection(source, true);
		const options = { idleTimeoutMs: 50, timeoutMs: 700 };
		const stream = kind === "stream" ? fixture.models.stream(model, context, options)
			: kind === "simple" ? fixture.models.streamSimple(model, context, options)
			: fixture.models.streamDeferred(model, { provider: model.provider, modelId: model.id, api: model.api, id: "job" }, options);
		const events = collect(stream);
		await vi.advanceTimersByTimeAsync(0);
		expect(source.demands).toHaveLength(1);
		expect(fixture.received()?.timeoutMs).toBe(700);
		expect(fixture.received()).not.toHaveProperty("idleTimeoutMs");
		await vi.advanceTimersByTimeAsync(50);
		const result = await stream.result();
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "Model stream idle timeout after 50ms" });
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(await events).toHaveLength(1);
		expect(source.cleanup).toHaveBeenCalledOnce();
		expect(fixture.received()?.signal?.aborted).toBe(true);
		expect(getEventListeners(fixture.received()!.signal!, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels pending next and return without retrying, and ignores late events", async () => {
		const source = new PendingStream();
		const fixture = collection(source, true);
		const caller = new AbortController();
		const stream = fixture.models.streamSimple(model, context, { signal: caller.signal, idleTimeoutMs: 50 });
		const events = collect(stream);
		await vi.advanceTimersByTimeAsync(0);
		caller.abort(new Error("user stopped"));
		await vi.advanceTimersByTimeAsync(0);
		const result = await stream.result();
		expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "user stopped" });
		expect(isRetryableAssistantError(result)).toBe(false);
		source.pushDemand({ type: "done", reason: "stop", message: fauxAssistantMessage("late") });
		await vi.advanceTimersByTimeAsync(100);
		expect(await events).toEqual([{ type: "error", reason: "aborted", error: result }]);
		expect(await stream.result()).toBe(result);
		expect(source.demands).toHaveLength(1);
		expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
		expect(getEventListeners(fixture.received()!.signal!, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["done", "error"] as const)("finishes after %s even when the source never ends or returns", async (kind) => {
		const source = new PendingStream();
		const fixture = collection(source);
		const stream = fixture.models.streamSimple(model, context);
		const events = collect(stream);
		await vi.advanceTimersByTimeAsync(0);
		const message = fauxAssistantMessage("terminal", { stopReason: kind === "done" ? "stop" : "error" });
		const expected = structuredClone(message);
		fixture.received()!.signal!.addEventListener("abort", () => {
			message.stopReason = "aborted";
			message.content = [{ type: "text", text: "late cleanup mutation" }];
		}, { once: true });
		source.pushDemand(kind === "done" ? { type: "done", reason: "stop", message }
			: { type: "error", reason: "error", error: message });
		expect(await stream.result()).toMatchObject(expected);
		expect(await stream.result()).not.toBe(message);
		expect(await events).toHaveLength(1);
		expect(source.demands).toHaveLength(1);
		expect(source.cleanup).toHaveBeenCalledOnce();
	});

	it("bounds result when iteration ends without a terminal event", async () => {
		const source = new PendingStream();
		const fixture = collection(source);
		const stream = fixture.models.streamSimple(model, context, { idleTimeoutMs: 50 });
		await vi.advanceTimersByTimeAsync(0);
		source.demands[0]!.resolve({ done: true, value: undefined });
		await vi.advanceTimersByTimeAsync(50);
		expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("idle timeout") });
		expect(await collect(stream)).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rearms only per demand and snapshots the last partial on timeout", async () => {
		const source = new PendingStream();
		const fixture = collection(source);
		const stream = fixture.models.streamSimple(model, context, { idleTimeoutMs: 50 });
		const events = collect(stream);
		const partial = fauxAssistantMessage("progress", { stopReason: "pending" });
		await vi.advanceTimersByTimeAsync(0);
		for (let index = 0; index < 8; index++) {
			await vi.advanceTimersByTimeAsync(40);
			source.pushDemand({ type: "text_delta", contentIndex: 0, delta: ".", partial });
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(1);
			expect(getEventListeners(fixture.received()!.signal!, "abort")).toHaveLength(1);
		}
		await vi.advanceTimersByTimeAsync(50);
		const result = await stream.result();
		partial.content = [{ type: "text", text: "late mutation" }];
		expect(result.content).toEqual([{ type: "text", text: "progress" }]);
		expect(await events).toHaveLength(9);
		expect(vi.getTimerCount()).toBe(0);
		expect(getEventListeners(fixture.received()!.signal!, "abort")).toHaveLength(0);
	});

	it("keeps a disabled deadline cancellable", async () => {
		const fixture = collection(new PendingStream());
		const caller = new AbortController();
		const stream = fixture.models.streamSimple(model, context, { idleTimeoutMs: 0, signal: caller.signal });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(vi.getTimerCount()).toBe(0);
		expect(fixture.received()?.signal?.aborted).toBe(false);
		caller.abort();
		expect((await stream.result()).stopReason).toBe("aborted");
	});

	it.each(["abort", "timeout"] as const)("does not dispatch after %s during auth", async (reason) => {
		const auth = Promise.withResolvers<{ auth: Record<string, never> }>();
		const dispatch = vi.fn(() => new PendingStream());
		const models = createModels();
		models.setProvider(createProvider({ id: model.provider, models: [model],
			auth: { apiKey: { name: "Local", resolve: () => auth.promise } },
			api: { stream: dispatch, streamSimple: dispatch } }));
		const caller = new AbortController();
		const options: ModelsSimpleStreamOptions = { signal: caller.signal, idleTimeoutMs: 50 };
		const stream = models.streamSimple(model, context, options);
		await vi.advanceTimersByTimeAsync(0);
		if (reason === "abort") caller.abort(); else await vi.advanceTimersByTimeAsync(50);
		expect((await stream.result()).stopReason).toBe(reason === "abort" ? "aborted" : "error");
		auth.resolve({ auth: {} });
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not invoke a lazily loaded provider after cancellation", async () => {
		const loaded = Promise.withResolvers<ProviderStreams>();
		const dispatch = vi.fn(() => new PendingStream());
		const api = lazyApi(() => loaded.promise);
		const caller = new AbortController();
		const stream = api.streamSimple(model, { messages: [] }, { signal: caller.signal });
		await vi.advanceTimersByTimeAsync(0);
		caller.abort();
		expect((await stream.result()).stopReason).toBe("aborted");
		loaded.resolve({ stream: dispatch, streamSimple: dispatch });
		await vi.advanceTimersByTimeAsync(0);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rejects invalid deadlines without starting setup", async () => {
		const setup = vi.fn(async () => new PendingStream());
		const stream = lazyStream(model, setup, { idleTimeoutMs: -1 });
		expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: "Invalid idleTimeoutMs: -1" });
		expect(setup).not.toHaveBeenCalled();
	});
});
