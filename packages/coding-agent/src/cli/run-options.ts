/** Neutral argument normalization and run options shared by every Python-backed mode. */
import { resolve } from "node:path";

import type { PythonRunOptions } from "../client/types.ts";
import type { Args } from "./args.ts";

export function requestOptions(parsed: Args): PythonRunOptions {
	const tools = parsed.tools ?? [];
	const modifiers = tools.some((name) => /^[+-]/.test(name));
	const allowed = modifiers
		? [
				...(parsed.noTools ? [] : parsed.noBuiltinTools ? ["mcp_*", "plugin_*"] : ["*"]),
				...tools.filter((name) => name.startsWith("+")).map((name) => name.slice(1)),
			]
		: (parsed.tools ?? (parsed.noTools ? [] : parsed.noBuiltinTools ? ["mcp_*", "plugin_*"] : undefined));
	const excluded = [
		...(parsed.excludeTools ?? []),
		...(modifiers ? tools.filter((name) => name.startsWith("-")).map((name) => name.slice(1)) : []),
		...(parsed.noMcp ? ["mcp_*"] : []),
		...(parsed.noExtensions && !parsed.extensions?.length ? ["plugin_*"] : []),
	];
	return {
		...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
		...((parsed.noContextFiles || parsed.noSkills || parsed.noPromptTemplates || parsed.skills?.length || parsed.promptTemplates?.length)
			? {
					resource_options: {
						...(parsed.noContextFiles ? { no_context_files: true } : {}),
						...(parsed.noSkills ? { no_skills: true } : {}),
						...(parsed.noPromptTemplates ? { no_prompt_templates: true } : {}),
						...(parsed.skills?.length ? { skill_paths: parsed.skills } : {}),
						...(parsed.promptTemplates?.length ? { prompt_paths: parsed.promptTemplates } : {}),
					},
				}
			: {}),
		...(parsed.systemPrompt === undefined ? {} : { system_prompt: parsed.systemPrompt }),
		...(parsed.appendSystemPrompt === undefined
			? {}
			: { append_system_prompt: parsed.appendSystemPrompt.join("\n\n") }),
		...(allowed === undefined ? {} : { allowed_tools: [...new Set(allowed)] }),
		...(excluded.length ? { excluded_tools: [...new Set(excluded)] } : {}),
	};
}

/** Target checks shared by every mode. Each error code is part of the CLI contract. */
export function validateTarget(parsed: Args): void {
	if ((parsed.pythonUrl === undefined) !== (parsed.pythonToken === undefined))
		throw new Error("python_target_required");
	if (parsed.noSession && parsed.pythonUrl) throw new Error("no_session_requires_local_host");
	if (parsed.decision && !["批准", "拒绝"].includes(parsed.decision)) throw new Error("invalid_decision");
	if ((parsed.request && parsed.call) || (parsed.approvalId && !parsed.request))
		throw new Error("decision_target_conflict");
	if (parsed.decision && parsed.request && !parsed.approvalId) throw new Error("approval_id_required");
	if (parsed.sessionDir && (parsed.noSession || parsed.pythonUrl))
		throw new Error("session_dir_requires_local_persistent_host");
}

/** The explicit session selector after the target checks. */
export function resolveSession(parsed: Args): string | undefined {
	const session = parsed.pythonSession ?? parsed.session;
	if (parsed.noSession && (parsed.continue || parsed.resume))
		throw new Error("--no-session cannot be combined with --continue or --resume");
	if (session !== undefined && !/^[a-f0-9]{32}$/.test(session)) throw new Error("invalid_session");
	if (parsed.continue && parsed.resume) throw new Error("session_selector_conflict");
	if (session !== undefined && (parsed.continue || parsed.resume || parsed.noSession))
		throw new Error("session_selector_conflict");
	return session;
}

export interface SessionOptions {
	readonly verbose?: boolean;
	readonly modelRef?: string;
	readonly provider?: string;
	readonly modelPatterns?: readonly string[];
	readonly sessionDir?: string;
	readonly extensions?: readonly string[];
	readonly noSession?: boolean;
	readonly selection?: "continue" | "resume";
	readonly title?: string;
}

export function sessionOptions(parsed: Args, cwd: string): SessionOptions {
	return {
		...(parsed.verbose ? { verbose: true } : {}),
		...(parsed.model ? { modelRef: parsed.model } : {}),
		...(parsed.provider ? { provider: parsed.provider } : {}),
		...(parsed.models?.length ? { modelPatterns: parsed.models } : {}),
		...(parsed.sessionDir ? { sessionDir: resolve(cwd, parsed.sessionDir) } : {}),
		...(parsed.extensions?.length ? { extensions: parsed.extensions.map((entry) => resolve(cwd, entry)) } : {}),
		...(parsed.noSession ? { noSession: true } : {}),
		...(parsed.continue
			? { selection: "continue" as const }
			: parsed.resume
				? { selection: "resume" as const }
				: {}),
		...(parsed.name ? { title: parsed.name } : {}),
	};
}

export type ProductCommand = (
	args: readonly string[],
	cwd: string,
	options?: { readonly input?: string; readonly quiet?: boolean; readonly sessionDir?: string },
) => Promise<boolean>;

export interface PreparedPythonRun {
	readonly session: string | undefined;
	readonly runOptions: PythonRunOptions;
	readonly sessionOptions: SessionOptions;
}

/**
 * Product commands, model listing, and typed-credential login run before any mode starts.
 * Returns undefined when one of them already completed the process.
 */
export async function preparePythonRun(
	parsed: Args,
	cwd: string,
	execute: ProductCommand,
): Promise<PreparedPythonRun | undefined> {
	validateTarget(parsed);
	const target = [
		...(parsed.pythonUrl === undefined ? [] : ["--python-url", parsed.pythonUrl]),
		...(parsed.pythonToken === undefined ? [] : ["--python-token", parsed.pythonToken]),
	];
	if (parsed.listModels !== undefined) {
		await execute(
			["models", ...target, ...(typeof parsed.listModels === "string" ? ["--search", parsed.listModels] : [])],
			cwd,
			{ sessionDir: parsed.sessionDir },
		);
		return undefined;
	}
	const session = resolveSession(parsed);
	if (parsed.provider || parsed.model || parsed.apiKey) {
		if (!parsed.model && !parsed.models?.length) throw new Error("model_required");
		if (parsed.apiKey) {
			if (!parsed.provider) throw new Error("provider_required");
			await execute(
				["auth", "login", "--provider", parsed.provider, "--method", "api-key", ...target],
				cwd,
				{ input: parsed.apiKey, quiet: true, sessionDir: parsed.sessionDir },
			);
			if (process.exitCode) return undefined;
		}
	}
	return { session, runOptions: requestOptions(parsed), sessionOptions: sessionOptions(parsed, cwd) };
}
