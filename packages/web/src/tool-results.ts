import type { ImagesOutputContent } from "@amazme/ai";
import type { ToolDiagnostic } from "@amazme/durable";
import type { Locale } from "./locale.ts";
import { translate } from "./strings.ts";

export interface ToolOutcome {
	readonly content: readonly ImagesOutputContent[];
	readonly details?: unknown;
	readonly isError?: boolean;
	readonly durationMs?: number;
	readonly diagnostics?: readonly ToolDiagnostic[];
}

export interface ToolResultView {
	readonly status: string;
	readonly duration?: string;
	readonly nested?: string;
	readonly diff?: { readonly text: string; readonly patch?: string; readonly path?: string; readonly label: string };
	readonly terminal?: { readonly command?: string; readonly cwd?: string; readonly exit?: string };
	readonly diagnostics: readonly { readonly tone: "error" | "muted"; readonly text: string }[];
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Presentation uses the executed result. Arguments alone never imply that a file changed. */
export function toolResultView(
	locale: Locale,
	name: string,
	args: unknown,
	result: ToolOutcome,
	nested = false,
): ToolResultView {
	const details = record(result.details);
	const diff = result.isError !== true && (name === "edit" || name === "write") ? text(details.diff) : undefined;
	const duration = result.durationMs;
	const exit = details.exit_code;
	return {
		status: translate(locale, result.isError === true ? "tool.failed" : "tool.completed"),
		...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0
			? { duration: translate(locale, "tool.duration", { seconds: (duration / 1000).toFixed(2) }) }
			: {}),
		...(nested ? { nested: translate(locale, "tool.nested") } : {}),
		...(diff === undefined
			? {}
			: {
					diff: {
						text: diff,
						patch: text(details.patch),
						path: text(record(args).path),
						label: translate(locale, "tool.appliedDiff"),
					},
				}),
		...(name !== "bash" && name !== "powershell"
			? {}
			: {
					terminal: {
						command: text(details.command),
						cwd: text(details.cwd),
						...(typeof exit === "number" && Number.isInteger(exit)
							? { exit: translate(locale, "tool.exitCode", { code: String(exit) }) }
							: {}),
					},
				}),
		diagnostics: (result.diagnostics ?? []).map((item) => ({
			tone: item.severity === "error" ? "error" : "muted",
			text: item.message,
		})),
	};
}

/** Tool images remain inline data; the renderer never fetches an arbitrary result URL. */
export function toolImages(
	content: readonly ImagesOutputContent[],
): { readonly dataUrl: string; readonly alt: string }[] {
	return content.flatMap((block) =>
		block.type === "image" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType)
			? [{ dataUrl: `data:${block.mimeType};base64,${block.data}`, alt: block.mimeType }]
			: [],
	);
}

/** The model's appended diagnostic block is displayed from its durable structured counterpart. */
export function toolOutputText(locale: Locale, result: ToolOutcome): string {
	const diagnostics = result.diagnostics ?? [];
	const suffix = `<harness>\n${diagnostics.map((item) => `[${item.severity}] ${item.message}`).join("\n")}\n</harness>`;
	const last = result.content.at(-1);
	const blocks =
		diagnostics.length > 0 && last?.type === "text" && last.text === suffix
			? result.content.slice(0, -1)
			: result.content;
	const output = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n\n")
		.trim();
	return (
		output ||
		(toolImages(result.content).length > 0
			? ""
			: translate(locale, result.isError ? "tool.errorText" : "tool.noOutput"))
	);
}
