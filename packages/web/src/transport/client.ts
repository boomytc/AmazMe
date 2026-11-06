/// <reference lib="dom" />
import type { Attachment, HttpOperations, Identity, Snapshot } from "../generated/contracts.ts";
import { ApiContractError, ApiError, parseContract, parseResponse, validateRequest } from "./api.ts";
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
	failure?: string;
	socket?: WebSocket;
	active(): boolean;
}

/**
 * `unavailable` is not a host outage: the host answered with a policy/status error (for example a
 * session worker that cannot start), so retrying the whole window would hide a live host.
 */
export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "unavailable"
	| "disconnected";

/**
 * Host policy closes that describe the session runtime, not the host transport itself. The reason is
 * a backend error code; an unavailable diagnostic worker also arrives as close(1008) this way.
 */
const SESSION_CLOSE_REASON =
	/^(?:startup_timeout|supervisor_|worker_|local_host_|execution_blocked|execution_cleanup_pending|diagnostic_worker_unavailable|attachment_capacity|stream_timeout|cursor_unavailable|stream_frame_too_large)/u;

class ConnectionIdentityError extends Error {}

/** Browser transport only. Python remains the sole owner of admissions and execution. */
export class PythonClient {
	identity?: Identity;
	connection?: ClientConnection;
	onChange: () => void = () => {};
	onStatus: (status: ConnectionStatus) => void = () => {};
	onError: (error: unknown) => void = () => {};
	private generation = 0;
	private retries = 0;
	/** The last failure came from the host's own answer, not from a broken transport. */
	private unavailable = false;
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
		if (identity.role !== "host" || identity.protocol !== "amazme-http/1" || !identity.host_epoch) throw new ConnectionIdentityError("后端启动身份不匹配，请重新启动。");
		if (this.identity && this.identity.profile_id !== identity.profile_id) throw new ConnectionIdentityError("宿主已更换；请重新打开对应窗口，原操作编号仍保留。");
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
			if (attachment.session_id !== sessionId || attachment.host_epoch !== identity.host_epoch) throw new ConnectionIdentityError("会话绑定不匹配，请重新打开窗口。");
			return await work(connection);
		}
		finally { await this.detach(connection); }
	}

	async connect(sessionId: string, resume = false): Promise<void> {
		if (!resume) this.retries = 0;
		const previous = this.connection;
		const cached = resume && this.connection?.sessionId === sessionId ? this.connection.snapshot : undefined;
		this.retire();
		if (previous?.sessionId === sessionId) this.connection = previous;
		const generation = ++this.generation;
		this.onStatus(resume ? "reconnecting" : "connecting");
		this.onChange();
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
			if (attachment.session_id !== sessionId || attachment.host_epoch !== identity.host_epoch) throw new ConnectionIdentityError("会话绑定不匹配，请重新打开窗口。");
			const url = new URL(`/api/v1/events/${encodeURIComponent(sessionId)}`, this.origin);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(url);
			connection.socket = socket;
			this.helloTimer = setTimeout(() => this.reconnect(connection), 40_000);
			socket.onopen = () => {
				if (!connection.active()) { socket.close(); return; }
				socket.send(JSON.stringify({ kind: "hello", binding_id: attachment.attachment_id, stream_id: cached?.stream_id ?? "", after: cached?.seq ?? "0" }));
			};
			socket.onmessage = event => {
				if (!connection.active() || this.timer) return;
				try {
					if (typeof event.data !== "string" || new TextEncoder().encode(event.data).length > 33 * 1024 * 1024) throw new Error("事件帧超过限制");
					const frame = parseContract("Stream", JSON.parse(event.data));
					connection.snapshot = applyFrame(connection.snapshot, frame, attachment);
					connection.ready = true;
					this.retries = 0;
					this.unavailable = false;
					clearTimeout(this.helloTimer);
					this.onStatus("connected");
					this.onChange();
					socket.send(JSON.stringify({ kind: "ack", binding_id: attachment.attachment_id, stream_id: frame.stream_id, seq: connection.snapshot.seq }));
				} catch (error) {
					if (error instanceof ApiContractError) this.failed(error);
					else { this.onError(error); this.reconnect(connection, true); }
				}
			};
			socket.onclose = event => {
				if (!connection.active()) return;
				const reason = event.reason.trim();
				if (event.code === 1008 || event.code === 1009) {
					// The host refuses this stream with a policy error (for example an exhausted
					// worker restart budget). Retrying would loop forever and hide the reason. A
					// session-level reason leaves the host answering (`unavailable`); a transport
					// or shutdown reason means the host connection itself is gone (`disconnected`).
					const sessionLevel =
						event.code === 1009 ||
						SESSION_CLOSE_REASON.test(reason);
					clearTimeout(this.helloTimer);
					clearTimeout(this.timer);
					this.timer = undefined;
					this.unavailable = sessionLevel;
					this.onStatus(sessionLevel ? "unavailable" : "disconnected");
					connection.ready = false;
					connection.failure = reason || `WebSocket ${event.code}`;
					this.onChange();
					this.onError(new Error(connection.failure));
					return;
				}
				this.reconnect(connection);
			};
		} catch (error) {
			if (generation !== this.generation) return;
			const terminal = error instanceof ConnectionIdentityError || error instanceof ApiContractError || error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
			if (terminal) {
				this.unavailable = false;
				this.failed(error, sessionId);
				return;
			}
			this.onError(error);
			/* An HTTP answer (5xx session start) means the host is up but the session is not. */
			this.unavailable = error instanceof ApiError;
			this.onStatus(this.unavailable ? "unavailable" : "disconnected");
			this.scheduleReconnect(sessionId, generation, 1000);
		}
	}

	private reconnect(connection: ClientConnection, fresh = false): void {
		if (!connection.active() || this.timer) return;
		connection.ready = false;
		if (fresh) connection.snapshot = undefined;
		clearTimeout(this.helloTimer);
		this.unavailable = false;
		this.onStatus("reconnecting");
		this.onChange();
		this.scheduleReconnect(connection.sessionId, this.generation, 750);
	}
	private scheduleReconnect(sessionId: string, generation: number, delay: number): void {
		if (this.retries >= 5) {
			/* A code, not prose: the presentation localizes it for the unavailable screen and toast. */
			this.failed(new Error("connection_not_restored"), sessionId);
			return;
		}
		this.retries++;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (generation === this.generation) void this.connect(sessionId, true);
		}, delay);
	}
	private failed(error: unknown, sessionId?: string): void {
		const identity = this.identity;
		const connection: ClientConnection | undefined = this.connection ?? (sessionId && identity ? {
			sessionId, identity, generation: this.generation, ready: false, active: () => false,
		} : undefined);
		this.retire();
		if (connection) {
			connection.failure = error instanceof Error ? error.message : String(error);
			this.connection = connection;
		}
		this.onStatus(this.unavailable ? "unavailable" : "disconnected");
		this.onChange();
		this.onError(error);
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
