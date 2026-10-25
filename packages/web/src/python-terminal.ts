/// <reference lib="dom" />
import { isRecord } from "./python-api.ts";
import type { TerminalType, TerminalView } from "./python-contracts.ts";
import { newId } from "./python-writes.ts";

export interface TerminalBinding {
	active(): boolean;
	send(input: TerminalType): Promise<TerminalView>;
	error(error: unknown): void;
	changed(): void;
}
const bytes = (value: string): number => new TextEncoder().encode(value).length;

/** One bounded input head at a time; reconnecting preserves uncertain bytes and IDs. */
export class TerminalInputQueue {
	readonly key: string;
	private readonly storage: Storage;
	private binding?: TerminalBinding;
	private pending: TerminalType[];
	paused: boolean;
	busy = false;
	constructor(storage: Storage, key: string) {
		this.storage = storage; this.key = key;
		const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
		if (!Array.isArray(value) || !value.every(item => isRecord(item) && typeof item.input_id === "string" && typeof item.data === "string")) throw new Error("终端待确认记录损坏；原记录已保留。");
		this.pending = value;
		this.paused = this.pending.length > 0;
	}
	get items(): readonly TerminalType[] { return this.pending; }
	bind(binding: TerminalBinding): void {
		if (this.binding && this.binding !== binding && this.pending.length) this.paused = true;
		this.binding = binding; this.changed();
	}
	private changed(): void { this.binding?.changed(); }
	private save(items: TerminalType[]): void {
		if (items.length) this.storage.setItem(this.key, JSON.stringify(items)); else this.storage.removeItem(this.key);
		this.pending = items; this.changed();
	}
	enqueue(data: string): void {
		if (this.paused) throw new Error("输入尚未确认；请重试原输入或核对后继续。");
		if (bytes(data) + this.pending.reduce((sum, item) => sum + bytes(item.data), 0) > 65536) throw new Error("终端输入队列已满（64 KiB）；本次输入未接收，请等待后重试。");
		const items = this.pending.map(item => ({ ...item }));
		let chunk = "";
		const append = () => {
			if (!chunk) return;
			const last = items.at(-1);
			if (last && !(this.busy && items.length === 1) && bytes(last.data + chunk) <= 4000) last.data += chunk;
			else items.push({ input_id: newId(), data: chunk });
			chunk = "";
		};
		for (const character of data) { if (bytes(chunk + character) > 4000) append(); chunk += character; }
		append(); this.save(items); void this.drain();
	}
	retry(): void { this.paused = false; this.changed(); void this.drain(); }
	confirm(): void { if (!this.busy) { this.save([]); this.paused = false; this.changed(); } }
	private async drain(): Promise<void> {
		const binding = this.binding;
		if (this.busy || this.paused || !binding) return;
		this.busy = true;
		try {
			while (this.pending.length && this.binding === binding && binding.active() && !this.paused) {
				const head = this.pending[0];
				const result = await binding.send(head);
				if (result.input_status !== "accepted" || result.input_id !== head.input_id) throw new Error("输入结果未知，未自动重发；请核对终端内容。");
				this.save(this.pending.filter(item => item.input_id !== head.input_id));
			}
		} catch (error) { this.paused = true; if (binding.active()) binding.error(error); }
		finally { this.busy = false; this.changed(); }
	}
}
