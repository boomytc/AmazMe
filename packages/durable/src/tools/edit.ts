import { type Static, Type } from "typebox";
import { FileError, getOrThrow } from "../env/index.ts";
import { observedEditIntent } from "../file-observations.ts";
import { defineTool } from "../harness/define.ts";
import type { ToolRegistration } from "../harness/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { requireEnv } from "./env.ts";
import { canonicalFilePath, withFileMutationQueue } from "../file-operations.ts";
import { observeMutation, priorFileObservation } from "./file-observations.ts";
import { resolveToolPath } from "../file-operations.ts";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };
type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/**
 * Repair shapes models commonly send: `edits` as a JSON string or as a single edit object, and a top-level
 * `oldText`/`newText` pair. Works on a copy; the call's arguments stay unchanged.
 */
function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as EditToolInput;
	const args: Record<string, unknown> = { ...input };
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return legacy;
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits };
}

export type EditToolDetails = {
	diff: string;
	patch: string;
	firstChangedLine?: number;
};

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

function editAccessError(path: string, error: FileError): Error {
	return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
}

export function createEditTool(): ToolRegistration<typeof editSchema, EditToolDetails> {
	return defineTool({
		name: "edit",
		description:
			"Read the file first, then edit it using exact text replacement. The observed path and version must remain current. Every edits[].oldText must match a unique, non-overlapping region of the original file. Merge nearby or overlapping changes into one edit. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(args, api, context) {
			const { path, edits } = validateEditInput(args);
			const env = requireEnv(api);
			const absolutePath = await resolveToolPath(env, path, context);
			return withFileMutationQueue(
				env,
				absolutePath,
				async () => {
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");
					const target = await canonicalFilePath(env, absolutePath, context);
					const intent = observedEditIntent(target, await priorFileObservation(api, env.id, target, context));
					const check = async () => {
						const current = await env.fileRevision(absolutePath, context);
						if (!current.ok && current.error.code !== "not_found") throw editAccessError(path, current.error);
						if (!current.ok || current.value.path !== intent.revision.path || current.value.version !== intent.revision.version) {
							throw new FileError("stale_version", `${path} changed since it was read; read it again`, absolutePath);
						}
					};
					await check();
					const readResult = await env.readTextFile(target, context);
					if (!readResult.ok) throw editAccessError(path, readResult.error);
					await check();
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					const { bom, text: content } = stripBom(readResult.value);
					const originalEnding = detectLineEnding(content);
					const normalizedContent = normalizeToLF(content);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
					if (context.abortSignal?.aborted) throw new Error("Operation aborted");

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					const diffResult = generateDiffString(baseContent, newContent);
					const details: EditToolDetails = {
						diff: diffResult.diff,
						patch: generateUnifiedPatch(path, baseContent, newContent),
						...(diffResult.firstChangedLine === undefined
							? {}
							: { firstChangedLine: diffResult.firstChangedLine }),
					};
					const outcome = getOrThrow(await env.writeFileChecked(absolutePath, finalContent, intent, context));
					await observeMutation(api, env.id, outcome);
					return {
						output: [
							{
								type: "text",
								text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
							},
						],
						details,
					};
				},
				context,
			);
		},
	});
}
