import { defineDoc, defineDocFamily } from "@amazme/durable";
import type { TaskId } from "@amazme/durable";
import { generateUnifiedPatch } from "@amazme/durable/tools/edit-diff";
import type { Image, Scope } from "./files.ts";

export type Snapshot = Scope & { name: string; createdAt: number; files: Image[] };
export type Plan = Scope & { id: string; snapshot: string; files: { before: Image; after: Image }[] };
export type Summary = { id: string; name: string; createdAt: number; paths: string[] };

export const Snapshots = defineDocFamily<Snapshot, Snapshot>({
	kind: "amazme.checkpoint.snapshot",
	version: 1,
	family: true,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: (value) => value,
});

export const Index = defineDoc<{ snapshots: Summary[]; lastRestore: TaskId | null }>({
	kind: "amazme.checkpoint.index",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ snapshots: [], lastRestore: null }),
});

export const Preview = defineDoc<{ plan: Plan | null; accepted: { caller: TaskId; task: TaskId } | null }>({
	kind: "amazme.checkpoint.preview",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ plan: null, accepted: null }),
});

/** One same-session restore owner; progress remains in that owner's durable task. */
export const RestoreOwner = defineDoc<{ task: TaskId | null }>({
	kind: "amazme.checkpoint.restore-owner",
	version: 1,
	scope: "session",
	initial: () => ({ task: null }),
});

export function summary(id: string, snapshot: Snapshot): Summary {
	return { id, name: snapshot.name, createdAt: snapshot.createdAt, paths: snapshot.files.map((file) => file.path) };
}

export function preview(plan: Plan) {
	let remaining = 12_000;
	return {
		plan: plan.id,
		snapshot: plan.snapshot,
		files: plan.files.map(({ before, after }) => {
			let patch: string | null = null;
			try {
				const decode = (data: string | null) => {
					const bytes = data === null ? new Uint8Array() : Buffer.from(data, "base64");
					if (bytes.length > 32_768 || bytes.includes(0)) throw new Error("Binary or large file");
					return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				};
				patch = generateUnifiedPatch(before.path, decode(before.data), decode(after.data));
			} catch {}
			const shown = patch?.slice(0, Math.min(remaining, 4000)) ?? null;
			remaining -= shown?.length ?? 0;
			return {
				path: before.path,
				version: before.version,
				action:
					before.data === after.data
						? "unchanged"
						: after.data === null
							? "delete"
							: before.data === null
								? "create"
								: "replace",
				beforeBytes: before.data === null ? null : Buffer.byteLength(before.data, "base64"),
				afterBytes: after.data === null ? null : Buffer.byteLength(after.data, "base64"),
				patch: shown,
				patchLimited: patch !== null && shown !== patch,
			};
		}),
	};
}
