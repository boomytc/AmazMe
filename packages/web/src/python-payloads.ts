/// <reference lib="dom" />

/** Large pending submissions outlive reloads without exhausting sessionStorage's small quota. */
export class PendingPayloads {
	private database?: Promise<IDBDatabase>;
	private readonly values = new Map<string, string>();
	private readonly writes = new Map<string, Promise<void>>();
	private open(): Promise<IDBDatabase> {
		return this.database ??= new Promise((resolve, reject) => {
			const request = indexedDB.open("amazme-pending-submissions", 1);
			request.onupgradeneeded = () => request.result.createObjectStore("payloads");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("无法打开待确认输入存储"));
		});
	}
	async restore(keys: readonly string[]): Promise<void> {
		if (!keys.length) return;
		const database = await this.open();
		await Promise.all(keys.map(key => new Promise<void>((resolve, reject) => {
			const request = database.transaction("payloads").objectStore("payloads").get(key);
			request.onsuccess = () => { const value: unknown = request.result; if (typeof value === "string") this.values.set(key, value); resolve(); };
			request.onerror = () => reject(request.error ?? new Error("无法读取原待确认输入"));
		})));
	}
	get(key: string): string {
		const value = this.values.get(key);
		if (value === undefined) throw new Error("原输入正文未能恢复；原编号已保留，请先核对结果。");
		return value;
	}
	put(key: string, value: string): void {
		this.values.set(key, value);
		const write = this.change(key, value);
		this.writes.set(key, write);
		// send() awaits the original promise before issuing any network request.
		void write.catch(() => undefined);
	}
	async flush(key: string): Promise<void> { await this.writes.get(key); }
	async remove(key: string): Promise<void> {
		await this.flush(key);
		await this.change(key);
		this.writes.delete(key); this.values.delete(key);
	}
	private async change(key: string, value?: string): Promise<void> {
		const database = await this.open();
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction("payloads", "readwrite");
			const store = transaction.objectStore("payloads");
			if (value === undefined) store.delete(key); else store.add(value, key);
			transaction.oncomplete = () => resolve();
			transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("原输入未能持久保存，尚未发送"));
		});
	}
}
