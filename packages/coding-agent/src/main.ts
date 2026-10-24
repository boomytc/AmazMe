/** Product presentation and input parsing; business operations belong to Python. */
import { resolve } from "node:path";
import { type Args, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import type { PythonRunOptions } from "./python-headless.ts";
import { VERSION } from "./config.ts";
import { runPythonProductCommand } from "./python-product.ts";

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
        ...(parsed.thinking === undefined ? {} : {thinking:parsed.thinking}),
		...((parsed.noContextFiles || parsed.noSkills || parsed.noPromptTemplates || parsed.skills?.length || parsed.promptTemplates?.length)
			? {resource_options: {
				...(parsed.noContextFiles ? {no_context_files:true} : {}),
				...(parsed.noSkills ? {no_skills:true} : {}),
				...(parsed.noPromptTemplates ? {no_prompt_templates:true} : {}),
				...(parsed.skills?.length ? {skill_paths:parsed.skills} : {}),
				...(parsed.promptTemplates?.length ? {prompt_paths:parsed.promptTemplates} : {}),
			}} : {}),
		...(parsed.systemPrompt === undefined ? {} : { system_prompt: parsed.systemPrompt }),
		...(parsed.appendSystemPrompt === undefined
			? {}
			: { append_system_prompt: parsed.appendSystemPrompt.join("\n\n") }),
		...(allowed === undefined ? {} : { allowed_tools: [...new Set(allowed)] }),
		...(excluded.length ? { excluded_tools: [...new Set(excluded)] } : {}),
	};
}

async function pipedInput(): Promise<string | undefined> {
	if (process.stdin.isTTY) return undefined;
	process.stdin.setEncoding("utf8");
	let value = "";
	for await (const chunk of process.stdin) {
		value += String(chunk);
		if (Buffer.byteLength(value) > 1024 * 1024) throw new Error("stdin_limit");
	}
	return value.trim() || undefined;
}

export async function main(args: string[]): Promise<void> {
	const cwd = process.cwd();
	if (await runPythonProductCommand(args, cwd)) return;
	const parsed = parseArgs(args);
	const invalid = parsed.diagnostics.find((item) => item.type === "error");
	if (invalid) throw new Error(invalid.message);
	if (parsed.unknownFlags.size) throw new Error(`Unknown option --${parsed.unknownFlags.keys().next().value}`);
	if (parsed.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	if (parsed.help) {
		printHelp(parsed.mode === "json" || parsed.mode === "rpc" ? process.stderr : process.stdout);
		return;
	}
	if ((parsed.pythonUrl === undefined) !== (parsed.pythonToken === undefined))
		throw new Error("python_target_required");
	if (parsed.noSession && parsed.pythonUrl) throw new Error("no_session_requires_local_host");
	if (parsed.decision && !["批准","拒绝"].includes(parsed.decision)) throw new Error("invalid_decision");
	if ((parsed.request && parsed.call) || (parsed.approvalId && !parsed.request)) throw new Error("decision_target_conflict");
	if (parsed.decision && parsed.request && !parsed.approvalId) throw new Error("approval_id_required");
	if (parsed.sessionDir && (parsed.noSession || parsed.pythonUrl)) throw new Error("session_dir_requires_local_persistent_host");
	const target = [
		...(parsed.pythonUrl === undefined ? [] : ["--python-url", parsed.pythonUrl]),
		...(parsed.pythonToken === undefined ? [] : ["--python-token", parsed.pythonToken]),
	];
	if (parsed.listModels !== undefined) {
		await runPythonProductCommand(
			["models", ...target, ...(typeof parsed.listModels === "string" ? ["--search", parsed.listModels] : [])],
			cwd,
			{sessionDir:parsed.sessionDir},
		);
		return;
	}
	const session = parsed.pythonSession ?? parsed.session;
	if (parsed.noSession && (parsed.continue || parsed.resume))
		throw new Error("--no-session cannot be combined with --continue or --resume");
	if (session !== undefined && !/^[a-f0-9]{32}$/.test(session)) throw new Error("invalid_session");
	if (parsed.continue && parsed.resume)
		throw new Error("session_selector_conflict");
	if (
		session !== undefined && (parsed.continue || parsed.resume || parsed.noSession))
		throw new Error("session_selector_conflict");
	if (parsed.provider || parsed.model || parsed.apiKey) {
        if (!parsed.model && !parsed.models?.length) throw new Error("model_required");
        if (parsed.apiKey) {
            if (!parsed.provider) throw new Error("provider_required");
            await runPythonProductCommand(["auth", "login", "--provider", parsed.provider, "--method", "api-key", ...target],
                cwd, {input:parsed.apiKey, quiet:true, sessionDir:parsed.sessionDir});
            if (process.exitCode) return;
        }
    }
	const runOptions = requestOptions(parsed);
	const sessionOptions = {
        ...(parsed.model ? {modelRef:parsed.model} : {}),
        ...(parsed.provider ? {provider:parsed.provider} : {}),
        ...(parsed.models?.length ? {modelPatterns:parsed.models} : {}),
		...(parsed.sessionDir ? {sessionDir:resolve(cwd,parsed.sessionDir)} : {}),
		...(parsed.extensions?.length ? {extensions:parsed.extensions.map((entry) => resolve(cwd,entry))} : {}),
        ...(parsed.noSession ? {noSession:true} : {}),
		...(parsed.continue
			? { selection: "continue" as const }
			: parsed.resume
				? { selection: "resume" as const }
				: {}),
		...(parsed.name ? { title: parsed.name } : {}),
	};
	const interactive = !parsed.print && parsed.mode === undefined && process.stdin.isTTY && process.stdout.isTTY;
	const appearance = {
		...(parsed.tuiMode ? {tuiMode:parsed.tuiMode} : {}),
		...(parsed.useTheme ? {theme:parsed.useTheme} : {}),
		...(parsed.noThemes ? {noThemes:true} : {}),
		...(parsed.themes?.length ? {themes:parsed.themes.map((entry) => resolve(cwd,entry))} : {}),
	};
	if (parsed.mode === "rpc" && parsed.fileArgs.length) throw new Error("RPC mode does not accept @file arguments");
	const stdinContent = interactive || parsed.mode === "rpc" ? undefined : await pipedInput();
	const files = parsed.fileArgs.length
		? await processFileArguments(parsed.fileArgs, { autoResizeImages: false })
		: undefined;
	const prepared = buildInitialMessage({
		parsed,
		...(stdinContent === undefined ? {} : { stdinContent }),
		...(files === undefined ? {} : { fileText: files.text, fileImages: files.images }),
	});
	const initial = {
		prompt:[prepared.initialMessage, ...parsed.messages].filter(Boolean).join("\n"),
		...(prepared.initialImages === undefined ? {} : {images:prepared.initialImages}),
	};
	if (interactive) {
		const { runOwnedPythonInteractive, runPythonSessionTui } = await import("./python-session-tui.ts");
		if (parsed.pythonUrl && parsed.pythonToken)
			await runPythonSessionTui({
				...runOptions,
				...sessionOptions,
				...initial,
				...appearance,
				url: parsed.pythonUrl,
				token: parsed.pythonToken,
				workspace: parsed.workspace || "primary",
				...(session === undefined ? {} : { session }),
			});
		else
			await runOwnedPythonInteractive({
				...runOptions,
				...sessionOptions,
				...initial,
				...appearance,
				cwd,
				...(parsed.workspace === undefined ? {} : {workspace:parsed.workspace}),
				...(session === undefined ? {} : { session }),
			});
		return;
	}

	const { runPythonHeadless } = await import("./python-headless.ts");
	process.exitCode = await runPythonHeadless({
		...runOptions,
		...sessionOptions,
		...initial,
		mode: parsed.mode === "rpc" ? "rpc" : parsed.mode === "json" ? "json" : "text",
		cwd,
		...(parsed.workspace === undefined ? {} : {workspace:parsed.workspace}),
		...(parsed.pythonUrl === undefined ? {} : { url: parsed.pythonUrl }),
		...(parsed.pythonToken === undefined ? {} : { token: parsed.pythonToken }),
		...(session === undefined ? {} : { session }),
		...(parsed.decision === undefined ? {} : { decision: parsed.decision }),
		...(parsed.request === undefined ? {} : { request: parsed.request }),
		...(parsed.approvalId === undefined ? {} : {approvalId:parsed.approvalId}),
		...(parsed.call === undefined ? {} : { call: parsed.call }),
	});
}
