import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

function createErrorMessage(model: Model<Api>, error: unknown, timestamp: number, aborted: boolean,
	partial?: AssistantMessage): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...(partial === undefined ? {} : structuredClone(partial)),
		stopReason: aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp,
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

export interface LazyStreamObserver {
	onEvent?(event: AssistantMessageEvent): void;
	onResult?(result: AssistantMessage | undefined): void;
}

/** The Models-owned deadline is independent of a provider's HTTP request timeout. */
export interface StreamLifetimeOptions {
	signal?: AbortSignal;
	/** Maximum wait for setup or one stream event. Zero or absent disables the deadline. */
	idleTimeoutMs?: number;
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Each demand owns its cancellation listener and idle timer.
 * A stalled provider cannot hold the returned stream open after cancellation or its deadline.
 */
export function lazyStream(
	model: Model<Api>,
	setup: (signal: AbortSignal) => Promise<AsyncIterable<AssistantMessageEvent>>,
	options: StreamLifetimeOptions = {},
	observer?: LazyStreamObserver,
): AssistantMessageEventStream {
	const startedAt = Date.now();
	const outer = new AssistantMessageEventStream();
	const controller = new AbortController();
	const signal = controller.signal;
	const onAbort = (): void => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	const wait = async <T>(work: () => T | PromiseLike<T>): Promise<T> => {
		signal.throwIfAborted();
		const timer = options.idleTimeoutMs
			? setTimeout(() => controller.abort(new Error(`Model stream idle timeout after ${options.idleTimeoutMs}ms`)), options.idleTimeoutMs)
			: undefined;
		try {
			return await raceWithAbortSignal(Promise.resolve().then(() => {
				signal.throwIfAborted();
				return work();
			}), signal);
		} finally {
			clearTimeout(timer);
		}
	};
	void (async () => {
		let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
		let exhausted = false;
		let partial: AssistantMessage | undefined;
		let result: AssistantMessage | undefined;
		try {
			const idle = options.idleTimeoutMs;
			if (idle !== undefined && (!Number.isInteger(idle) || idle < 0 || idle > 2_147_483_647))
				throw new Error(`Invalid idleTimeoutMs: ${String(idle)}`);
			const inner = await wait(() => setup(signal));
			signal.throwIfAborted();
			const current = inner[Symbol.asyncIterator]();
			iterator = current;
			for (;;) {
				const next = await wait(() => current.next());
				signal.throwIfAborted();
				if (next.done) {
					exhausted = true;
					if (!hasResult(inner)) throw new Error("Stream ended without a terminal response");
					result = structuredClone(await wait(() => inner.result()));
					signal.throwIfAborted();
					outer.end(result);
					return;
				}
				const event = next.value;
				if (event.type === "done" || event.type === "error") {
					// Cleanup may still mutate the provider's message after its terminal event.
					result = structuredClone(event.type === "done" ? event.message : event.error);
					const terminal: AssistantMessageEvent = event.type === "done" ? { ...event, message: result }
						: { ...event, error: result };
					outer.push(terminal);
					observer?.onEvent?.(terminal);
					outer.end();
					return;
				}
				outer.push(event);
				observer?.onEvent?.(event);
				partial = event.partial;
			}
		} catch (error) {
			const reason = options.signal?.aborted === true ? "aborted" : "error";
			result = createErrorMessage(model, error, startedAt, reason === "aborted", partial);
			const event: AssistantMessageEvent = { type: "error", reason, error: result };
			outer.push(event);
			observer?.onEvent?.(event);
			outer.end(result);
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			controller.abort();
			// Async generators queue return behind a pending next. The signal owns provider teardown;
			// observe a late cleanup failure without letting an abandoned demand re-hang settlement.
			if (!exhausted && iterator?.return) {
				try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* already settled */ }
			}
			observer?.onResult?.(result);
		}
	})();

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export interface LazyApiCapabilities {
	fetchDeferred?: boolean;
	cancelDeferred?: boolean;
}

export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			lazyStream(model, async (signal) => {
				const implementation = await load();
				signal.throwIfAborted();
				return implementation.stream(model, context, { ...options, signal });
			}, options),
		streamSimple: (model, context, options) =>
			lazyStream(model, async (signal) => {
				const implementation = await load();
				signal.throwIfAborted();
				return implementation.streamSimple(model, context, { ...options, signal });
			}, options),
	};

	if (capabilities?.fetchDeferred) {
		api.fetchDeferred = (model, handle, options) =>
			lazyStream(model, async (signal) => {
				const implementation = await load();
				signal.throwIfAborted();
				if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
				return implementation.fetchDeferred(model, handle, { ...options, signal });
			}, options);
	}
	if (capabilities?.cancelDeferred) {
		api.cancelDeferred = async (model, handle, options) => {
			const implementation = await load();
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	return api;
}
