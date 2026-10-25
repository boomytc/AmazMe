/// <reference lib="dom" />
import type { HttpOperations, Identity } from "./python-contracts.ts";
import { definitive, isRecord, validateRequest } from "./python-api.ts";
import type { ClientConnection, PythonClient } from "./python-client.ts";
import { PendingPayloads } from "./python-payloads.ts";

export const newId = (): string => crypto.randomUUID().replaceAll("-", "");

type Operation = keyof HttpOperations;
export interface PendingWrite<K extends Operation = Operation> {
	readonly id: string;
	readonly operation: K;
	readonly path: HttpOperations[K]["path"];
	readonly body: HttpOperations[K]["body"];
}

/** Each record has one host, one session, and its original operation ID. Nothing is replayed on reconnect. */
export class PendingWrites {
	private static readonly payloads = new PendingPayloads();
	static async restore(storage: Storage): Promise<void> {
		const keys: string[] = [];
		for (let index = 0; index < storage.length; index++) {
			const key = storage.key(index);
			if (!key?.startsWith("amazme:write:") || key.endsWith(":uncertain")) continue;
			try {
				const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
				if (isRecord(value) && typeof value.payload === "string" && value.payload === `${key}:${value.id}`) keys.push(value.payload);
			} catch { /* A damaged record stays available for explicit reconciliation. */ }
		}
		await this.payloads.restore(keys);
	}
	readonly prefix: string;
	private readonly storage: Storage;
	private readonly running = new Set<string>();
	constructor(storage: Storage, host: string, session: string) {
		this.storage = storage;
		this.prefix = `amazme:write:${host}:${session}:`;
	}
	read<K extends Operation>(key: string, operation: K): PendingWrite<K> | undefined {
		const raw = this.storage.getItem(this.prefix + key);
		if (!raw) return undefined;
		let value: unknown = JSON.parse(raw);
		if (isRecord(value) && typeof value.payload === "string") {
			if (value.payload !== `${this.prefix}${key}:${value.id}`) throw new Error("待确认输入归属不匹配；原记录已保留。");
			const restored: unknown = JSON.parse(PendingWrites.payloads.get(value.payload));
			if (!isRecord(restored) || restored.id !== value.id || restored.operation !== value.operation) throw new Error("原输入编号不匹配；记录已保留。");
			value = restored;
		}
		if (!isRecord(value) || typeof value.id !== "string" || value.operation !== operation || !isRecord(value.path)) throw new Error("待确认操作记录损坏；原记录已保留。");
		validateRequest(operation, value.body);
		return value as unknown as PendingWrite<K>;
	}
	prepare<K extends Operation>(key: string, operation: K, create: (id: string) => Pick<PendingWrite<K>, "path" | "body">): PendingWrite<K> {
		const existing = this.read(key, operation);
		if (existing) return existing;
		const id = newId();
		const record: PendingWrite<K> = { id, operation, ...create(id) };
		validateRequest(operation, record.body);
		const raw = JSON.stringify(record), storageKey = this.prefix + key;
		if (operation === "POST /api/v1/sessions/{session}/submissions" && raw.length > 128_000) {
			const payload = `${storageKey}:${id}`;
			this.storage.setItem(storageKey, JSON.stringify({ id, operation, path: record.path, payload }));
			PendingWrites.payloads.put(payload, raw);
		} else this.storage.setItem(storageKey, raw);
		return record;
	}
	async forget(key: string, record: PendingWrite): Promise<void> {
		const storageKey = this.prefix + key;
		const raw = this.storage.getItem(storageKey);
		if (!raw) return;
		const current: unknown = JSON.parse(raw);
		if (isRecord(current) && current.id === record.id) {
			if (typeof current.payload === "string" && current.payload === `${storageKey}:${record.id}`) await PendingWrites.payloads.remove(current.payload);
			if (this.storage.getItem(storageKey) !== raw) return;
			this.storage.removeItem(storageKey);
			if (this.storage.getItem(storageKey + ":uncertain") === record.id) this.storage.removeItem(storageKey + ":uncertain");
		}
	}
	private uncertain(key: string, record: PendingWrite): void {
		const raw = this.storage.getItem(this.prefix + key);
		const current: unknown = raw ? JSON.parse(raw) : undefined;
		if (isRecord(current) && current.id === record.id) this.storage.setItem(this.prefix + key + ":uncertain", record.id);
	}
	isRunning(key: string): boolean { return this.running.has(key); }
	async send<K extends Operation>(key: string, record: PendingWrite<K>, client: PythonClient, binding: ClientConnection | Identity): Promise<HttpOperations[K]["response"]> {
		const connection = "sessionId" in binding ? binding : undefined;
		const identity = connection?.identity ?? ("profile_id" in binding ? binding : undefined);
		if (!identity || this.prefix !== `amazme:write:${identity.profile_id}:${connection?.sessionId ?? ""}:`) throw new Error("操作属于其他会话或宿主；原记录已保留。");
		for (const field of ["session", "session_id"]) {
			const target: unknown = Reflect.get(record.path, field);
			if (target !== undefined && target !== connection?.sessionId) throw new Error("操作目标与原会话不一致；原记录已保留。");
		}
		const boundBody: unknown = record.body;
		if (isRecord(boundBody) && typeof boundBody.session_id === "string" && boundBody.session_id !== connection?.sessionId) throw new Error("操作内容属于其他会话；原记录已保留。");
		if (connection ? !connection.active() || !connection.ready : client.identity !== identity) throw new Error("请等待原会话或宿主重新连接；操作编号仍保留。");
		if (this.running.has(key)) throw new Error("原操作仍在发送");
		this.running.add(key);
		try {
			await PendingWrites.payloads.flush(`${this.prefix}${key}:${record.id}`);
			const result = await client.call(record.operation, { path: record.path, body: record.body, ...(connection ? { connection } : { identity }) });
			const value: unknown = result;
			const body: unknown = record.body;
			if (isRecord(value) && isRecord(body) && typeof body.branch_id === "string" && value.session_id !== body.branch_id) throw new Error("分支回执编号不匹配；原记录已保留。");
			if (isRecord(value) && isRecord(body)) for (const field of ["operation_id", "request_id", "terminal_id", "call_id", "compaction_id", "workflow_id", "plugin_id", "schedule_id"]) {
				if (typeof body[field] === "string" && typeof value[field] === "string" && body[field] !== value[field]) throw new Error("回执操作编号不匹配；原记录已保留。");
			}
			const acceptedDecision = record.operation === "POST /api/v1/sessions/{session}/approvals" || record.operation === "POST /api/v1/sessions/{session}/effects/resolve";
			if (acceptedDecision || !isRecord(value) || (value.phase !== "unknown" && value.input_status !== "unknown" && value.status !== "unknown")) await this.forget(key, record);
			else this.uncertain(key, record);
			return result;
		} catch (error) {
			if (!definitive(error)) this.uncertain(key, record);
			else if (this.storage.getItem(this.prefix + key + ":uncertain") !== record.id) await this.forget(key, record);
			throw error;
		} finally { this.running.delete(key); }
	}
}
