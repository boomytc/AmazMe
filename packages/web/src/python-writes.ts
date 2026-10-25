/// <reference lib="dom" />
import type { HttpOperations } from "./python-contracts.ts";
import { definitive, isRecord } from "./python-api.ts";
import type { ClientConnection, PythonClient } from "./python-client.ts";

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
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || typeof value.id !== "string" || value.operation !== operation || !isRecord(value.path)) throw new Error("待确认操作记录损坏；原记录已保留。");
		// The generated request schema is checked again by PythonClient before sending.
		return value as unknown as PendingWrite<K>;
	}
	prepare<K extends Operation>(key: string, operation: K, create: (id: string) => Pick<PendingWrite<K>, "path" | "body">): PendingWrite<K> {
		const existing = this.read(key, operation);
		if (existing) return existing;
		const id = newId();
		const record: PendingWrite<K> = { id, operation, ...create(id) };
		this.storage.setItem(this.prefix + key, JSON.stringify(record));
		return record;
	}
	forget(key: string, record: PendingWrite): void {
		const storageKey = this.prefix + key;
		const raw = this.storage.getItem(storageKey);
		if (!raw) return;
		const current: unknown = JSON.parse(raw);
		if (isRecord(current) && current.id === record.id) this.storage.removeItem(storageKey);
	}
	isRunning(key: string): boolean { return this.running.has(key); }
	async send<K extends Operation>(key: string, record: PendingWrite<K>, client: PythonClient, connection: ClientConnection): Promise<HttpOperations[K]["response"]> {
		if (this.prefix !== `amazme:write:${connection.identity.profile_id}:${connection.sessionId}:`) throw new Error("操作属于其他会话；原记录已保留。");
		for (const field of ["session", "session_id"]) {
			const target: unknown = Reflect.get(record.path, field);
			if (target !== undefined && target !== connection.sessionId) throw new Error("操作目标与原会话不一致；原记录已保留。");
		}
		if (!connection.active() || !connection.ready) throw new Error("请等待原会话重新连接；操作编号仍保留。");
		if (this.running.has(key)) throw new Error("原操作仍在发送");
		this.running.add(key);
		try {
			const result = await client.call(record.operation, { path: record.path, body: record.body, connection });
			const value: unknown = result;
			if (!isRecord(value) || (value.phase !== "unknown" && value.input_status !== "unknown" && value.status !== "unknown")) this.forget(key, record);
			return result;
		} catch (error) {
			if (definitive(error)) this.forget(key, record);
			throw error;
		} finally { this.running.delete(key); }
	}
}
