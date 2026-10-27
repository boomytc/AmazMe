/// <reference lib="dom" />
import type { Attachment, HttpOperations, Identity, Snapshot } from "../generated/contracts.ts";
import { ApiError, parseContract, parseResponse, validateRequest } from "./api.ts";
import { applyFrame } from "./stream.ts";

type Options<K extends keyof HttpOperations> = {
	readonly path?: HttpOperations[K]["path"];
	readonly query?: HttpOperations[K]["query"];
	readonly body?: HttpOperations[K]["body"];
	readonly connection?: ClientConnection;
	readonly identity?: Identity;
};

export interface ClientConnection {
	readonly sessionId: string;
	readonly generation: number;
	readonly identity: Identity;
	attachment?: Attachment;
	snapshot?: Snapshot;
	ready: boolean;
	socket?: WebSocket;
	active(): boolean;
}

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

/** Browser transport only. Python remains the sole owner of admissions and execution. */
export class PythonClient {
	identity?: Identity;
	connection?: ClientConnection;
	onChange: () => void = () => {};
	onStatus: (status: ConnectionStatus) => void = () => {};
	onError: (error: unknown) => void = () => {};
	private generation = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private helloTimer?: ReturnType<typeof setTimeout>;
	readonly origin: string;
	constructor(origin: string) { this.origin = origin; }

	async call<K extends keyof HttpOperations>(operation: K, options: Options<K> = {}): Promise<HttpOperations[K]["response"]> {
		const [method, template] = operation.split(" ");
		const path = template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
			const value: unknown = options.path && Reflect.get(options.path, key);
			if (typeof value !== "string" || !value) throw new Error(`缺少请求路径：${key}`);
			return encodeURIComponent(value);
		});
		const url = new URL(path, this.origin);
		for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
		const headers: Record<string, string> = {};
		if (method !== "GET") {
			const fence = options.connection?.identity ?? options.identity ?? this.identity;
			if (!fence) throw new Error("请先连接后端");
			headers["x-amazme-build"] = fence.build_id;
			headers["x-amazme-epoch"] = String(fence.host_epoch);
			if (options.connection?.attachment) headers["x-amazme-attachment"] = options.connection.attachment.attachment_id;
		}
		validateRequest(operation, options.body);
		if (options.body !== undefined) headers["Content-Type"] = "application/json";
		const response = await fetch(url, { method, headers, credentials: "same-origin", body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(30_000) });
		const value: unknown = await response.json();
		if (!response.ok) throw new ApiError(response.status, value);
		return parseResponse(operation, value);
	}

	async bootstrap(): Promise<Identity> {
		const identity = await this.call("GET /api/v1/bootstrap");
		if (identity.role !== "host" || identity.protocol !== "amazme-http/1" || !identity.host_epoch) throw new Error("后端启动身份不匹配");
		if (this.identity && this.identity.profile_id !== identity.profile_id) throw new Error("宿主已更换；请重新打开对应窗口，原操作编号仍保留。");
		if (this.identity && this.identity.build_id !== identity.build_id) throw new Error("后端版本已更换；请刷新页面，原操作编号仍保留。");
		this.identity = identity;
		return identity;
	}

	/** Sidebar management may address a session other than the visible conversation. */
	async withSession<T>(sessionId: string, work: (connection: ClientConnection) => Promise<T>): Promise<T> {
		const current = this.connection;
		if (current?.sessionId === sessionId && current.ready && current.active()) return work(current);
		const identity = this.identity;
		if (!identity) throw new Error("请先连接后端");
		const attachment = await this.call("POST /api/v1/sessions/{session}/attachments", { path: { session: sessionId }, identity });
		const connection: ClientConnection = { sessionId, identity, attachment, generation: this.generation, ready: true,
			active: () => this.identity === identity };
		try {
			if (attachment.session_id !== sessionId || attachment.build_id !== identity.build_id || attachment.host_epoch !== identity.host_epoch) throw new Error("会话绑定不匹配");
			return await work(connection);
		}
		finally { await this.detach(connection); }
	}

	async connect(sessionId: string, resume = false): Promise<void> {
		const cached = resume && this.connection?.sessionId === sessionId ? this.connection.snapshot : undefined;
		this.retire();
		const generation = ++this.generation;
		this.onStatus(resume ? "reconnecting" : "connecting");
		try {
			const identity = await this.bootstrap();
			if (generation !== this.generation) return;
			const connection: ClientConnection = { sessionId, generation, identity, ready: false, snapshot: cached,
				active: () => this.connection === connection && generation === this.generation };
			this.connection = connection;
			this.onChange();
			const attachment = await this.call("POST /api/v1/sessions/{session}/attachments", { path: { session: sessionId }, identity });
			connection.attachment = attachment;
			if (!connection.active()) { void this.detach(connection); return; }
			if (attachment.session_id !== sessionId || attachment.build_id !== identity.build_id || attachment.host_epoch !== identity.host_epoch) throw new Error("会话绑定不匹配");
			const url = new URL(`/api/v1/events/${encodeURIComponent(sessionId)}`, this.origin);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(url);
			connection.socket = socket;
			this.helloTimer = setTimeout(() => this.reconnect(connection), 40_000);
			socket.onopen = () => {
				if (!connection.active()) { socket.close(); return; }
				socket.send(JSON.stringify({ kind: "hello", binding_id: attachment.attachment_id, build_id: identity.build_id, stream_id: cached?.stream_id ?? "", after: cached?.seq ?? "0" }));
			};
			socket.onmessage = event => {
				if (!connection.active() || this.timer) return;
				try {
					if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 33 * 1024 * 1024) throw new Error("事件帧超过限制");
					const frame = parseContract("Stream", JSON.parse(event.data));
					connection.snapshot = applyFrame(connection.snapshot, frame, attachment);
					connection.ready = true;
					clearTimeout(this.helloTimer);
					this.onStatus("connected");
					this.onChange();
					socket.send(JSON.stringify({ kind: "ack", binding_id: attachment.attachment_id, stream_id: frame.stream_id, seq: connection.snapshot.seq }));
				} catch (error) { this.onError(error); this.reconnect(connection, true); }
			};
			socket.onclose = () => this.reconnect(connection);
			socket.onerror = () => this.reconnect(connection);
		} catch (error) {
			if (generation !== this.generation) return;
			this.onError(error);
			this.onStatus("disconnected");
			if (!(error instanceof ApiError && error.status === 401)) this.timer = setTimeout(() => {
				this.timer = undefined;
				if (generation === this.generation) void this.connect(sessionId, true);
			}, 1000);
		}
	}

	private reconnect(connection: ClientConnection, fresh = false): void {
		if (!connection.active() || this.timer) return;
		connection.ready = false;
		if (fresh) connection.snapshot = undefined;
		clearTimeout(this.helloTimer);
		this.onStatus("reconnecting");
		this.onChange();
		this.timer = setTimeout(() => { this.timer = undefined; void this.connect(connection.sessionId, true); }, 750);
	}
	private async detach(connection: ClientConnection): Promise<void> {
		if (!connection.attachment) return;
		try { await this.call("DELETE /api/v1/sessions/{session}/attachments/{identity}", { path: { session: connection.sessionId, identity: connection.attachment.attachment_id }, connection }); }
		catch { /* The host also expires abandoned bindings; no business request is replayed. */ }
	}
	retire(): void {
		clearTimeout(this.timer);
		clearTimeout(this.helloTimer);
		this.timer = undefined;
		const previous = this.connection;
		this.connection = undefined;
		this.generation++;
		if (previous) { previous.ready = false; previous.socket?.close(); void this.detach(previous); }
	}
}
