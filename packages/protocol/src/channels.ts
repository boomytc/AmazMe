/** Multiplex Chord links over the application's authenticated, attachment-fenced transport. */
import { encodeFrameObject, memoryLinkPair, type Context, type Frame, type Host, type JsonValue, type Link } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ServiceDescription } from "./services.ts";

const channel = Type.String({ minLength: 1, maxLength: 160 });
export const ChannelCallSchema = Type.Union([
	Type.Object({ kind: Type.Literal("catalogue") }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("open"), channel, host: Type.Optional(Type.String()) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("frame"),
			channel,
			frame: Type.Unsafe<Frame>(Type.Object({ t: Type.String() }, { additionalProperties: true })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("close"), channel }, { additionalProperties: false }),
]);
export type ChannelCall = Static<typeof ChannelCallSchema>;
export function parseChannelCall(value: unknown): ChannelCall {
	if (!Check(ChannelCallSchema, value)) throw new TypeError("Invalid Chord channel call");
	return value;
}
export function frameJson(frame: Frame): JsonValue {
	return JSON.parse(JSON.stringify(encodeFrameObject(frame))) as JsonValue;
}
export function parseChannelFrame(value: unknown): Frame {
	if (value === null || typeof value !== "object" || !("t" in value) || typeof value.t !== "string")
		throw new TypeError("Invalid Chord frame");
	return value as Frame;
}

export class ChannelEndpoint {
	readonly #hosts: ReadonlyMap<string, Host>;
	readonly #identity = globalThis.crypto.randomUUID();
	readonly #catalogue: () => readonly ServiceDescription[];
	readonly #links = new Map<string, { link: Link; host: Host; principal: object }>();
	#disposed = false;
	constructor(host: Host, catalogue: () => readonly ServiceDescription[], additional: readonly Host[] = []) {
		this.#hosts = new Map([host, ...additional].map((entry) => [entry.name, entry]));
		this.#catalogue = catalogue;
	}
	async invoke(
		call: ChannelCall,
		publish: (channel: string, frame: Frame | undefined, context: Context) => void | Promise<void>,
		context: Context,
	): Promise<JsonValue | undefined> {
		if (this.#disposed) throw new Error("Channel endpoint is closed");
		context.abortSignal?.throwIfAborted();
		if (call.kind === "catalogue") return this.#catalogue() as unknown as JsonValue;
		if (call.kind === "open") {
			if (this.#links.has(call.channel)) throw new Error("Channel already exists");
			const host = call.host === undefined ? this.#hosts.values().next().value : this.#hosts.get(call.host);
			if (!host) throw new Error("Unknown Chord host");
			const [accepted, wire] = memoryLinkPair();
			const principal = { endpoint: this.#identity, channel: call.channel };
			const entry = { link: wire, host, principal };
			this.#links.set(call.channel, entry);
			let tail = Promise.resolve();
			wire.receive((frame) => {
				tail = tail
					.then(async () => {
						if (!this.#disposed) await publish(call.channel, frame, BACKGROUND_CONTEXT);
					})
					.catch(() => wire.close("transport failed"));
			});
			wire.onClose(() => {
				void Promise.resolve(publish(call.channel, undefined, BACKGROUND_CONTEXT)).catch(() => {});
			});
			host.accept(accepted, { principal });
			return { host: host.name };
		}
		const entry = this.#links.get(call.channel);
		if (call.kind === "close") {
			if (entry) {
				this.#links.delete(call.channel);
				entry.link.close();
				await entry.host.invalidatePrincipal((principal) => principal === entry.principal);
			}
			return;
		}
		if (!entry) throw new Error("Channel is not open");
		entry.link.send(call.frame);
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const entries = [...this.#links.values()];
		this.#links.clear();
		for (const entry of entries) entry.link.close();
		const results = await Promise.allSettled(
			entries.map((entry) => entry.host.invalidatePrincipal((principal) => principal === entry.principal)),
		);
		const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (errors.length)
			throw new AggregateError(
				errors.map((result) => result.reason),
				"Channel cleanup failed",
			);
	}
}

export type ChannelInvoker = (
	call: ChannelCall,
	publish: (channel: string, frame: Frame | undefined, context: Context) => void | Promise<void>,
	context: Context,
) => Promise<JsonValue | undefined>;

/** A native Chord link over an already authenticated application attachment. */
export async function openChannel(
	invoke: ChannelInvoker,
	context: Context,
	host?: string,
): Promise<{ link: Link; host: string; close(): Promise<void> }> {
	const channel = `chord-${globalThis.crypto.randomUUID()}`;
	const [link, wire] = memoryLinkPair();
	let tail = Promise.resolve();
	let closing: Promise<void> | undefined;
	let remoteClosed = false;
	const publish = (_channel: string, frame: Frame | undefined) => {
		if (frame === undefined) {
			remoteClosed = true;
			wire.close();
		} else wire.send(frame);
	};
	const close = (): Promise<void> =>
		(closing ??= Promise.resolve().then(async () => {
			wire.close();
			await tail;
			if (!remoteClosed) await invoke({ kind: "close", channel }, publish, BACKGROUND_CONTEXT);
		}));
	try {
		const opened = await invoke({ kind: "open", channel, ...(host === undefined ? {} : { host }) }, publish, context);
		if (!opened || typeof opened !== "object" || !("host" in opened) || typeof opened.host !== "string")
			throw new Error("Invalid channel response");
		wire.receive((frame) => {
			tail = tail
				.then(async () => {
					if (!closing)
						await invoke(
							{ kind: "frame", channel, frame: parseChannelFrame(frameJson(frame)) },
							publish,
							BACKGROUND_CONTEXT,
						);
				})
				.catch(() => wire.close());
		});
		return { link, host: opened.host, close };
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}
