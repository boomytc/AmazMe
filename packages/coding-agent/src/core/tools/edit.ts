import type { AgentTool } from "@amazme/agent";
import { FileError, getOrThrow } from "@amazme/durable/env";
import { observedEditIntent } from "@amazme/durable/file-observations";
import { canonicalFilePath, resolveToolPath, withFileMutationQueue } from "@amazme/durable/file-operations";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import {
	createFileRuntime,
	type FileToolOptions,
	observePublished,
	readObservedBytes,
	throwIfAborted,
} from "./file-runtime.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({
			description: "Replacement text for this targeted edit.",
		}),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({
			description: "Path to the file to edit (relative or absolute)",
		}),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

export type EditToolOptions = FileToolOptions;

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
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
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): {
	path: string;
	edits: Edit[];
} {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const runtime = createFileRuntime(cwd, options);
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a previously read file using exact text replacement. The observed version must remain current. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const { path, edits } = validateEditInput(input);
			const { files, context, observations } = runtime(signal, ctx);
			throwIfAborted(context);
			const absolutePath = await resolveToolPath(files, path, context);
			return withFileMutationQueue(
				files,
				absolutePath,
				async () => {
					throwIfAborted(context);
					const target = await canonicalFilePath(files, absolutePath, context);
					const intent = observedEditIntent(target, observations.get(files.id, target));
					const revision = getOrThrow(await files.fileRevision(absolutePath, context));
					if (revision.path !== intent.revision.path || revision.version !== intent.revision.version)
						throw new FileError(
							"stale_version",
							`File changed since it was read: ${path}. Read it again before editing.`,
							absolutePath,
						);
					const read = await readObservedBytes(files, absolutePath, context);
					if (!read.stable || read.path !== intent.revision.path || read.version !== intent.revision.version)
						throw new FileError(
							"stale_version",
							`File changed while preparing the edit: ${path}. Read it again before editing.`,
							absolutePath,
						);
					const rawContent = read.buffer.toString("utf-8");
					// Strip BOM before matching. The model will not include an invisible BOM in oldText.
					const { bom, text: content } = splitBom(rawContent);
					const originalEnding = detectLineEnding(content);
					const normalizedContent = normalizeToLF(content);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
					throwIfAborted(context);

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					const diffResult = generateDiffString(baseContent, newContent);
					const patch = generateUnifiedPatch(path, baseContent, newContent);
					const outcome = getOrThrow(await files.writeFileChecked(absolutePath, finalContent, intent, context));
					const warning = await observePublished(observations, files.id, outcome);
					return {
						content: [
							{
								type: "text",
								text: `Successfully replaced ${edits.length} block(s) in ${path}.${warning}`,
							},
						],
						details: {
							diff: diffResult.diff,
							patch,
							firstChangedLine: diffResult.firstChangedLine,
						},
					};
				},
				context,
			);
		},
		...editRenderers,
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
