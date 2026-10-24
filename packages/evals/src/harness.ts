import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonValue, NormalizedSessionSchema, UsageSummarySchema } from "@vitest-evals/core";
import { createHarness, type Harness, type SimpleHarnessResult } from "vitest-evals/harness";
import { z } from "zod";
import type { DocumentationVariant } from "./plan.ts";

export type CodingAgentInput = string | Array<{ type: "prompt"; content: string }>;
export type CodingAgentModelSelection = { provider: string; id: string };
export type ProviderProbe = {
	path?: string;
	provider: string;
	model: string;
	api: "openai-completions" | "anthropic-messages";
	base_url: string;
	api_key: string;
	prompt: string;
};
export type CodingAgentHarnessOptions = {
	name?: string;
	model?: CodingAgentModelSelection;
	noTools?: "all";
	tools?: readonly string[];
	workspaceFiles?: Readonly<Record<string, string>>;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	documentation?: DocumentationVariant;
	pluginEntry?: string;
	providerProbe?: () => ProviderProbe;
	timeoutMs?: number;
};
const ResultSchema = z.object({
	response: z.string(),
	session: NormalizedSessionSchema,
	usage: UsageSummarySchema,
	evidence: z.record(z.string(), z.json()),
	errors: z.array(z.string()),
});
export type NativeEvalResult = z.infer<typeof ResultSchema>;
export type CodingAgentHarnessWithOutput<TOutput extends JsonValue> = CodingAgentHarnessOptions & {
	output: (result: NativeEvalResult) => TOutput | Promise<TOutput>;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveModelSelection(
	explicitModel: CodingAgentModelSelection | undefined,
	environment: { AMAZME_PROVIDER?: string; AMAZME_MODEL?: string } = process.env,
): CodingAgentModelSelection {
	const provider = (explicitModel?.provider ?? environment.AMAZME_PROVIDER)?.trim();
	const id = (explicitModel?.id ?? environment.AMAZME_MODEL)?.trim();
	if (!provider || !id)
		throw new Error("Select a harness model explicitly or set both AMAZME_PROVIDER and AMAZME_MODEL as defaults.");
	return { provider, id };
}

export async function runNativeEval(
	input: CodingAgentInput,
	options: CodingAgentHarnessOptions,
	signal?: AbortSignal,
): Promise<NativeEvalResult> {
	const model = resolveModelSelection(options.model);
	if (model.provider !== "faux" && !process.env.AMAZME_EVAL_PROFILE)
		throw new Error("AMAZME_EVAL_PROFILE must name an existing Python credential profile.");
	signal?.throwIfAborted();
	const request = {
		provider: model.provider,
		model: model.id,
		prompts: typeof input === "string" ? [input] : input.map((item) => item.content),
		credential_profile: process.env.AMAZME_EVAL_PROFILE ?? "",
		tools: options.tools ?? (options.noTools ? [] : null),
		system_prompt: options.systemPrompt ?? null,
		append_system_prompt: options.appendSystemPrompt ?? "",
		workspace_files: options.workspaceFiles ?? {},
		documentation: options.documentation ?? null,
		plugin_entry: options.pluginEntry ?? "",
		provider_probe: options.providerProbe?.() ?? null,
		timeout_ms: options.timeoutMs ?? 300_000,
	};
	return new Promise((accept, reject) => {
		const child = spawn(resolve(root, "backend/.venv/bin/python"), [resolve(root, "backend/tools/run_eval.py")], {
			cwd: root,
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf8");
		let output = "";
		let size = 0;
		let failure: Error | undefined;
		const cancel = () => child.kill("SIGINT");
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		child.stdout.on("data", (chunk: string) => {
			size += Buffer.byteLength(chunk, "utf8");
			if (size > 8 * 1024 * 1024) {
				failure ??= new Error("eval_output_limit");
				cancel();
			} else output += chunk;
		});
		// The runner returns sanitized error codes; raw stderr may contain provider diagnostics.
		child.stderr.resume();
		child.stdin.on("error", () => {
			failure ??= new Error("eval_input_failed");
		});
		child.on("error", (error) => {
			failure ??= error;
		});
		child.on("close", (code) => {
			signal?.removeEventListener("abort", cancel);
			if (failure) return reject(failure);
			if (signal?.aborted) return reject(signal.reason);
			if (code !== 0) return reject(new Error("eval_runner_failed"));
			try {
				accept(ResultSchema.parse(JSON.parse(output)));
			} catch {
				reject(new Error("eval_result_invalid"));
			}
		});
		child.stdin.end(`${JSON.stringify(request)}\n`);
	});
}

export function createCodingAgentHarness<TOutput extends JsonValue>(
	options: CodingAgentHarnessWithOutput<TOutput>,
): Harness<CodingAgentInput, TOutput>;
export function createCodingAgentHarness(options?: CodingAgentHarnessOptions): Harness<CodingAgentInput, string>;
export function createCodingAgentHarness<TOutput extends JsonValue>(
	options: CodingAgentHarnessOptions | CodingAgentHarnessWithOutput<TOutput> = {},
): Harness<CodingAgentInput, string | TOutput> {
	return createHarness<CodingAgentInput, string | TOutput>({
		name: options.name ?? "AmazMe Python",
		async run({ input, signal, setArtifact }): Promise<SimpleHarnessResult<string | TOutput>> {
			const start = performance.now();
			const result = await runNativeEval(input, options, signal);
			setArtifact("native", result.evidence);
			if (!result.session.events.length && result.errors.length) throw new Error(result.errors.join(","));
			setArtifact("nativeSessionJsonl", result.session.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
			return {
				output: "output" in options ? await options.output(result) : result.response,
				events: result.session.events,
				usage: result.usage,
				errors: result.errors,
				timings: { totalMs: performance.now() - start },
			};
		},
	});
}

export const DOCUMENTATION_EVAL_TOOLS = ["read_file", "write_file"] as const;
export function resolveDocumentationVariant(value = process.env.AMAZME_EVAL_VARIANT): DocumentationVariant {
	if (value === "without_docs" || value === "with_docs") return value;
	throw new TypeError('AMAZME_EVAL_VARIANT must be "without_docs" or "with_docs".');
}
export function createDocumentationEvalHarness<TOutput extends JsonValue>(
	options: CodingAgentHarnessWithOutput<TOutput>,
): Harness<CodingAgentInput, TOutput>;
export function createDocumentationEvalHarness(options?: CodingAgentHarnessOptions): Harness<CodingAgentInput, string>;
export function createDocumentationEvalHarness<TOutput extends JsonValue>(
	options: CodingAgentHarnessOptions | CodingAgentHarnessWithOutput<TOutput> = {},
) {
	const variant = resolveDocumentationVariant();
	return createCodingAgentHarness({
		...options,
		name: variant,
		documentation: variant,
		tools: options.tools ?? DOCUMENTATION_EVAL_TOOLS,
	});
}
