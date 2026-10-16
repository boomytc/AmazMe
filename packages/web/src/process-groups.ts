import type { TranscriptBlock } from "./view.ts";

export interface ProcessGroup {
	readonly kind: "process";
	readonly id: string;
	readonly blocks: readonly TranscriptBlock[];
	readonly state: "running" | "completed" | "error" | "interrupted";
	readonly tools: number;
	readonly thoughts: number;
	/** Failures the run never resolved: a collapsed group surfaces these without being opened. */
	readonly alert: readonly TranscriptBlock[];
	/** Steps that failed and were followed by a later successful step. */
	readonly recovered: number;
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
		// A working run fails and corrects itself constantly. Only a failure that no later step
		// resolved — the tail after the last success — is an outcome the reader has to see.
		const lastSuccess = pending.findLastIndex(block => block.kind === "tool" && block.result !== undefined && !failed(block));
		const failures = pending.filter(failed);
		const alert = pending.filter((block, index) => index > lastSuccess && failed(block));
		const active = pending.findLast(block => block.running);
		const unsettled = pending.some(block => block.kind === "tool" && block.result === undefined);
		const interrupted = pending.some(block => block.interrupted) || boundary?.interrupted === true;
		items.push({
			kind: "process", id: String(pending[0]!.id), blocks: pending,
			state: active !== undefined || (busy && boundary === undefined && !interrupted) ? "running" : interrupted ? "interrupted" : alert.length > 0 || (boundary?.kind === "notice" && boundary.tone === "error") ? "error" : unsettled ? "interrupted" : "completed",
			tools: pending.filter(block => block.kind === "tool").length,
			thoughts: pending.filter(block => block.kind === "thinking").length,
			alert, recovered: failures.length - alert.length, activity: active ?? pending.at(-1),
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
