import type { TranscriptBlock } from "./view.ts";

export interface ProcessGroup {
	readonly kind: "process";
	readonly id: string;
	readonly blocks: readonly TranscriptBlock[];
	/** Execution lifecycle only, never a claim that the requested outcome was verified. */
	readonly state: "running" | "completed" | "error" | "interrupted";
	readonly tools: number;
	readonly thoughts: number;
	/** Every recorded failure remains discoverable; later success does not prove a repair. */
	readonly failures: readonly TranscriptBlock[];
	readonly activity: TranscriptBlock | undefined;
}

export type TranscriptItem = ProcessGroup | { readonly kind: "block"; readonly block: TranscriptBlock };

function failed(block: TranscriptBlock): boolean {
	return block.tone === "error" || block.result?.diagnostics.some(item => item.tone === "error") === true;
}

/** Group only adjacent process events. Blank assistant placeholders are not boundaries. */
export function processGroups(blocks: readonly TranscriptBlock[], busy = false): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	let pending: TranscriptBlock[] = [];
	const finish = (boundary?: TranscriptBlock): void => {
		if (pending.length === 0) return;
		const active = pending.findLast(block => block.running);
		const unsettled = pending.some(block => block.kind === "tool" && block.result === undefined);
		const interrupted = pending.some(block => block.interrupted) || boundary?.interrupted === true;
		items.push({
			kind: "process", id: String(pending[0]!.id), blocks: pending,
			state: active !== undefined || (busy && boundary === undefined && !interrupted) ? "running" : interrupted || unsettled ? "interrupted" : boundary?.kind === "notice" && boundary.tone === "error" ? "error" : "completed",
			tools: pending.filter(block => block.kind === "tool").length,
			thoughts: pending.filter(block => block.kind === "thinking").length,
			failures: pending.filter(failed), activity: active ?? pending.at(-1),
		});
		pending = [];
	};
	for (const block of blocks) {
		if ((block.kind === "assistant" || block.kind === "thinking") && block.text.trim().length === 0) continue;
		if (block.kind === "tool" || block.kind === "thinking") pending.push(block);
		else { finish(block); items.push({ kind: "block", block }); }
	}
	finish();
	return items;
}
