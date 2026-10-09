import type { Context } from "@amazme/chord";
import { withoutAbortSignal } from "@amazme/chord/context";
import { getOrThrow } from "@amazme/durable/env";
import type { ExecutionEnv, FileRevision } from "@amazme/durable/env";
import { readPlan } from "./plan.ts";
import type { Plan } from "./plan.ts";

const MAX_BYTES = 262144;

/** Bounded read of a regular file with a revision for conditional publication. */
export async function readTemplate(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<{ text: string; version: FileRevision | null }> {
	const opened = await env.openBinaryReader(path, { noFollow: true }, context);
	if (!opened.ok) {
		if (opened.error.code === "not_found") return { text: "", version: null };
		throw opened.error;
	}
	const reader = opened.value;
	try {
		const before = getOrThrow(await reader.revision(context));
		const size = getOrThrow(await reader.info(context)).size;
		if (size > MAX_BYTES) throw new Error("Workflow template exceeds 256 KiB");
		const bytes = new Uint8Array(size);
		for (let offset = 0; offset < size; ) {
			const chunk = getOrThrow(await reader.read(offset, size - offset, context));
			if (chunk.length === 0) throw new Error("Workflow template changed while reading");
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		const after = getOrThrow(await reader.revision(context)),
			version = getOrThrow(await env.fileRevision(path, context));
		if (before !== after || after !== version.version) throw new Error("Workflow template changed while reading");
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			version,
		};
	} finally {
		await reader.close(withoutAbortSignal(context));
	}
}

export async function loadTemplate(env: ExecutionEnv, path: string, context: Context) {
	const file = await readTemplate(env, path, context);
	if (file.version === null) throw new Error("Workflow template was not found");
	return {
		plan: readPlan(JSON.parse(file.text)),
		path: file.version.path,
		version: file.version.version,
	};
}

export async function saveTemplate(
	env: ExecutionEnv,
	path: string,
	plan: Plan,
	expectedVersion: string | undefined,
	context: Context,
) {
	const text = `${JSON.stringify(plan, null, 2)}\n`;
	if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("Workflow template exceeds 256 KiB");
	const current = await readTemplate(env, path, context);
	if (current.text === text && current.version !== null)
		return { path: current.version.path, version: current.version.version };
	if (
		(expectedVersion !== undefined && current.version?.version !== expectedVersion) ||
		(current.version !== null && expectedVersion === undefined)
	)
		throw new Error("Template exists or changed; load its current version before replacement");
	const published = getOrThrow(
		await env.writeFileChecked(
			path,
			text,
			current.version === null ? { kind: "createIfAbsent" } : { kind: "replaceIfVersion", revision: current.version },
			context,
		),
	);
	return { path: published.path, version: published.version ?? null };
}

/** Explicit bounded discovery; loading a directory never starts its plans. */
export async function listTemplates(env: ExecutionEnv, path: string, context: Context) {
	const opened = await env.openDirReader(path, context);
	if (!opened.ok) {
		if (opened.error.code === "not_found") return { templates: [], limited: false };
		throw opened.error;
	}
	try {
		const page = getOrThrow(await opened.value.next(100, context));
		const templates: {
			path: string;
			name: string | null;
			description: string | null;
			problem: string | null;
		}[] = [];
		for (const entry of page.entries) {
			if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
			try {
				const loaded = await loadTemplate(env, entry.path, context);
				templates.push({
					path: loaded.path,
					name: loaded.plan.name,
					description: loaded.plan.description.slice(0, 300),
					problem: null,
				});
			} catch (error) {
				context.abortSignal?.throwIfAborted();
				templates.push({
					path: entry.path,
					name: null,
					description: null,
					problem: error instanceof Error ? error.message.slice(0, 300) : "Invalid current workflow template",
				});
			}
		}
		return { templates, limited: !page.done };
	} finally {
		await opened.value.close(withoutAbortSignal(context));
	}
}
