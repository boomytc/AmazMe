import { memoryLinkPair, type Link, type JsonValue } from "@amazme/chord";
import { frameJson, parseChannelFrame, parseChannelCall, type ChannelCall } from "@amazme/protocol";
import type { ServiceDescription } from "@amazme/protocol/services";
import {
	type AttachmentEnvelope,
	encodeClientMessage,
	isServerId,
	ProtocolValidationError,
	type ResponseEnvelope,
	type RpcTarget,
	type ServerHello,
	type ChannelEventEnvelope,
	type SessionTarget,
} from "@amazme/protocol";
import { Connection } from "./connection.ts";
import { ClientDisposedError, DisconnectedError, ServerError, toError } from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import type {
	AttachmentChangeListener,
	ClientOptions,
	ConnectionState,
	ConnectionStateChange,
	Unsubscribe,
} from "./types.ts";

type ServiceResult = JsonValue | undefined;

interface PendingRequest {
	resolve(result: ServiceResult): void;
	reject(error: Error): void;
	cleanup(): void;
}

export class Client {
	readonly #options: ClientOptions;
	readonly #connection: Connection;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	readonly #attachmentListeners = new Set<AttachmentChangeListener>();
	readonly #channels = new Map<string, { target: RpcTarget; wire: Link }>();
	#requestSequence = 0;
	#channelSequence = 0;
	#hello: ServerHello | undefined;
	#attachment: SessionTarget | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: ClientOptions) {
		if (!isServerId(options.serverId)) {
			throw new TypeError("serverId must be a canonical lowercase UUIDv4");
		}
		this.#options = options;
		this.#connection = new Connection({
			transportFactory: options.transportFactory,
			serverId: options.serverId,
			maxFrameLength: options.maxFrameLength,
			onHandshake: (hello) => {
				this.#hello = hello;
			},
			onMessage: (message) => this.#handleMessage(message),
			onStateChange: (change) => this.#handleConnectionStateChange(change),
		});
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get connectionState(): ConnectionState {
		return this.#connection.state;
	}

	get connected(): boolean {
		return this.#connection.state === "connected";
	}

	get serverId(): string {
		return this.#options.serverId;
	}

	get hello(): ServerHello | undefined {
		return this.#hello;
	}

	get attachment(): SessionTarget | undefined {
		return this.#attachment;
	}

	static async connect(options: ClientOptions): Promise<Client> {
		const client = new Client(options);
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.dispose();
			throw error;
		}
	}

	connect(): Promise<ServerHello> {
		if (this.#disposed) return Promise.reject(new ClientDisposedError());
		this.#hello = undefined;
		return this.#connection.connect();
	}

	reconnect(): Promise<ServerHello> {
		return this.connect();
	}

	disconnect(reason = "Client disconnected"): void {
		this.#connection.disconnect(reason);
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#assertNotDisposed();
		this.#connectionStateListeners.add(listener);
		return () => this.#connectionStateListeners.delete(listener);
	}

	onAttachmentChange(listener: AttachmentChangeListener): Unsubscribe {
		this.#assertNotDisposed();
		this.#attachmentListeners.add(listener);
		return () => this.#attachmentListeners.delete(listener);
	}

	/** Deliver a Chord channel operation to an explicit attachment-fenced target. */
	request(target: RpcTarget, call: ChannelCall, signal?: AbortSignal): Promise<ServiceResult> {
		return this.#request(target, call, signal);
	}

	async describeServices(target: RpcTarget, signal?: AbortSignal): Promise<readonly ServiceDescription[]> {
		const value = await this.#request(target, { kind: "catalogue" }, signal);
		if (
			!Array.isArray(value) ||
			value.some(
				(entry) =>
					entry === null || typeof entry !== "object" || !("serviceId" in entry) || typeof entry.serviceId !== "string",
			)
		) {
			throw new ProtocolValidationError("Invalid application service catalogue");
		}
		return value as unknown as ServiceDescription[];
	}

	async openLink(
		target: RpcTarget,
		host?: string,
		signal?: AbortSignal,
	): Promise<{ link: Link; host: string; close(): Promise<void> }> {
		if (!this.#targetIsCurrent(target)) throw new DisconnectedError();
		signal?.throwIfAborted();
		const channel = `chord-${++this.#channelSequence}`;
		const [link, wire] = memoryLinkPair();
		this.#channels.set(channel, { target, wire });
		try {
			const opened = await this.#request(
				target,
				{ kind: "open", channel, ...(host === undefined ? {} : { host }) },
				signal,
			);
			if (opened === null || typeof opened !== "object" || !("host" in opened) || typeof opened.host !== "string")
				throw new ProtocolValidationError("Invalid Chord channel response");
			if (!this.#targetIsCurrent(target) || !this.#channels.has(channel)) throw new DisconnectedError();
			let tail = Promise.resolve();
			wire.receive((frame) => {
				tail = tail
					.then(async () => {
						if (this.#channels.has(channel) && this.#targetIsCurrent(target))
							await this.#request(target, { kind: "frame", channel, frame: parseChannelFrame(frameJson(frame)) });
					})
					.catch((error: unknown) => {
						wire.close(String(error));
						this.#reportListenerError(error);
					});
			});
			let closing: Promise<void> | undefined;
			const close = (): Promise<void> =>
				(closing ??= Promise.resolve().then(async () => {
					const present = this.#channels.delete(channel);
					wire.close();
					await tail;
					if (present && this.connected && this.#targetIsCurrent(target))
						await this.#request(target, { kind: "close", channel });
				}));
			wire.onClose(() => {
				void close().catch((error: unknown) => this.#reportListenerError(error));
			});
			return { link, host: opened.host, close };
		} catch (error) {
			this.#channels.delete(channel);
			wire.close();
			if (this.connected && this.#targetIsCurrent(target))
				void this.#request(target, { kind: "close", channel }).catch((error) => this.#reportListenerError(error));
			throw error;
		}
	}

	#request<T = ServiceResult>(
		target: RpcTarget,
		call: ChannelCall,
		signal?: AbortSignal,
		transform?: (result: ServiceResult) => T,
	): Promise<T> {
		if (this.#disposed) return Promise.reject(new ClientDisposedError());
		if (!this.connected) return Promise.reject(new DisconnectedError());
		if (signal?.aborted) return Promise.reject(abortError(signal));
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<T>();
		let sent = false;
		let aborted = false;
		let onAbort: (() => void) | undefined;
		const sendCancel = (): void => {
			if (!sent || !this.connected) return;
			try {
				this.#connection.send(
					encodeClientMessage({ type: "cancel", id, target }, { maxFrameLength: this.#connection.maxFrameLength }),
				);
			} catch (error) {
				this.#connection.fail(toError(error));
			}
		};
		if (signal !== undefined) {
			onAbort = () => {
				if (aborted) return;
				aborted = true;
				reject(abortError(signal));
				sendCancel();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
		this.#pendingRequests.set(id, {
			resolve: (result) => {
				try {
					resolve(transform === undefined ? (result as T) : transform(result));
				} catch (error) {
					const validationError = new ProtocolValidationError(
						error instanceof Error ? error.message : "Invalid service operation stream",
					);
					this.#connection.fail(validationError);
					reject(validationError);
				}
			},
			reject,
			cleanup: () => {
				if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
			},
		});
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, target, call: parseChannelCall(call) as unknown as JsonValue },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise;
		}
		this.#connection.send(frame);
		sent = true;
		if (aborted) sendCancel();
		return promise;
	}

	#handleMessage(message: ResponseEnvelope | ChannelEventEnvelope | AttachmentEnvelope): void {
		if (message.type === "attachment") {
			if (message.attachment !== null && message.attachment.serverId !== this.#options.serverId) {
				this.#connection.fail(new ProtocolValidationError("Attachment update belongs to another server"));
				return;
			}
			this.#setAttachment(message.attachment ?? undefined);
			return;
		}
		if (message.type === "channel_closed") {
			const channel = this.#channels.get(message.channelId);
			if (channel) {
				this.#channels.delete(message.channelId);
				channel.wire.close("Remote channel closed");
			}
			return;
		}
		if (message.type === "channel_frame") {
			const channel = this.#channels.get(message.channelId);
			if (channel && this.#targetIsCurrent(channel.target)) {
				try {
					channel.wire.send(parseChannelFrame(message.frame));
				} catch (error) {
					this.#connection.fail(toError(error));
				}
			}
			return;
		}
		const pending = this.#takePendingRequest(message.id);
		if (!pending) {
			this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new ServerError(message.error));
			return;
		}
		pending.resolve(message.result);
	}

	#handleConnectionStateChange(change: ConnectionStateChange): void {
		if (change.state === "disconnected") {
			this.#hello = undefined;
			this.#setAttachment(undefined);
			this.#rejectPendingRequests(change.error ?? new DisconnectedError());
			for (const channel of [...this.#channels.values()]) channel.wire.close("transport closed");
			this.#channels.clear();
		}
		for (const listener of this.#connectionStateListeners) {
			try {
				listener(change);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#takePendingRequest(id: string): PendingRequest | undefined {
		const request = this.#pendingRequests.get(id);
		if (request) {
			this.#pendingRequests.delete(id);
			request.cleanup();
		}
		return request;
	}

	#rejectPendingRequests(error: Error): void {
		const requests = [...this.#pendingRequests.values()];
		this.#pendingRequests.clear();
		for (const request of requests) {
			request.cleanup();
			request.reject(error);
		}
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = Promise.resolve();
		const error = new ClientDisposedError();
		this.#rejectPendingRequests(error);
		this.#connection.disconnect(error);
		this.#hello = undefined;
		this.#setAttachment(undefined);
		this.#connectionStateListeners.clear();
		this.#attachmentListeners.clear();
		for (const channel of [...this.#channels.values()]) channel.wire.close("transport closed");
		this.#channels.clear();
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#setAttachment(attachment: SessionTarget | undefined): void {
		const previous = this.#attachment;
		if (
			previous?.serverId === attachment?.serverId &&
			previous?.sessionId === attachment?.sessionId &&
			previous?.attachmentId === attachment?.attachmentId
		) {
			return;
		}
		this.#attachment = attachment;
		for (const channel of [...this.#channels.values()])
			if (!this.#targetIsCurrent(channel.target)) channel.wire.close("attachment changed");
		for (const listener of this.#attachmentListeners) {
			try {
				listener(attachment);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#targetIsCurrent(target: RpcTarget): boolean {
		if (!("sessionId" in target)) return this.#hello?.serverId === target.serverId;
		const attachment = this.#attachment;
		return (
			attachment?.serverId === target.serverId &&
			attachment.sessionId === target.sessionId &&
			attachment.attachmentId === target.attachmentId
		);
	}

	#assertNotDisposed(): void {
		if (this.#disposed) throw new ClientDisposedError();
	}

	#reportListenerError(error: unknown): void {
		if (!this.#options.onListenerError) return;
		try {
			this.#options.onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect protocol or transport state.
		}
	}
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
