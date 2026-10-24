/** Product presentation and input parsing; business operations belong to Python. */
import { parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { VERSION } from "./config.ts";
import { runPythonProductCommand } from "./python-product.ts";

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
	if (parsed.unknownFlags.size)
		throw new Error(
			`Unknown option --${parsed.unknownFlags.keys().next().value}`,
		);
	if (parsed.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	if (parsed.help) {
		printHelp();
		return;
	}
	if ((parsed.pythonUrl === undefined) !== (parsed.pythonToken === undefined))
		throw new Error("python_target_required");
	const target = [
		...(parsed.pythonUrl === undefined
			? []
			: ["--python-url", parsed.pythonUrl]),
		...(parsed.pythonToken === undefined
			? []
			: ["--python-token", parsed.pythonToken]),
	];
	if (parsed.listModels !== undefined) {
		await runPythonProductCommand(
			[
				"models",
				...target,
				...(typeof parsed.listModels === "string"
					? ["--search", parsed.listModels]
					: []),
			],
			cwd,
		);
		return;
	}
	const session = parsed.pythonSession ?? parsed.session;
	if (parsed.noSession && (parsed.continue || parsed.resume))
		throw new Error(
			"--no-session cannot be combined with --continue or --resume",
		);
	if (session !== undefined && !/^[a-f0-9]{32}$/.test(session))
		throw new Error("invalid_session");
	if (
		parsed.session !== undefined &&
		(parsed.continue || parsed.resume || parsed.noSession)
	)
		throw new Error("session_selector_conflict");
	if (parsed.provider || parsed.model || parsed.apiKey) {
		if (!parsed.model) throw new Error("model_required");
		if (parsed.apiKey) {
			if (!parsed.provider) throw new Error("provider_required");
			await runPythonProductCommand(
				[
					"auth",
					"login",
					"--provider",
					parsed.provider,
					"--method",
					"api-key",
					...target,
				],
				cwd,
				{ input: parsed.apiKey, quiet: true },
			);
			if (process.exitCode) return;
		}
		await runPythonProductCommand(
			[
				"model",
				"--model",
				parsed.model,
				...(parsed.provider ? ["--provider", parsed.provider] : []),
				...target,
			],
			cwd,
			{ quiet: true },
		);
		if (process.exitCode) return;
	}
	const interactive =
		!parsed.print &&
		parsed.mode === undefined &&
		process.stdin.isTTY &&
		process.stdout.isTTY;
	if (interactive) {
		const { runOwnedPythonInteractive, runPythonSessionTui } = await import(
			"./python-session-tui.ts"
		);
		if (parsed.pythonUrl && parsed.pythonToken)
			await runPythonSessionTui({
				url: parsed.pythonUrl,
				token: parsed.pythonToken,
				workspace: parsed.workspace || "primary",
				...(session === undefined ? {} : { session }),
			});
		else
			await runOwnedPythonInteractive({
				cwd,
				workspace: parsed.workspace || "primary",
				...(session === undefined ? {} : { session }),
			});
		return;
	}
	if (parsed.mode === "rpc" && parsed.fileArgs.length)
		throw new Error("RPC mode does not accept @file arguments");
	const stdinContent = parsed.mode === "rpc" ? undefined : await pipedInput();
	const files = parsed.fileArgs.length
		? await processFileArguments(parsed.fileArgs, { autoResizeImages: false })
		: undefined;
	const prepared = buildInitialMessage({
		parsed,
		...(stdinContent === undefined ? {} : { stdinContent }),
		...(files === undefined
			? {}
			: { fileText: files.text, fileImages: files.images }),
	});
	const { runPythonHeadless } = await import("./python-headless.ts");
	process.exitCode = await runPythonHeadless({
		mode:
			parsed.mode === "rpc" ? "rpc" : parsed.mode === "json" ? "json" : "text",
		cwd,
		workspace: parsed.workspace || "primary",
		prompt: [prepared.initialMessage, ...parsed.messages]
			.filter(Boolean)
			.join("\n"),
		...(parsed.pythonUrl === undefined ? {} : { url: parsed.pythonUrl }),
		...(parsed.pythonToken === undefined ? {} : { token: parsed.pythonToken }),
		...(session === undefined ? {} : { session }),
		...(parsed.decision === undefined ? {} : { decision: parsed.decision }),
		...(parsed.request === undefined ? {} : { request: parsed.request }),
		...(parsed.call === undefined ? {} : { call: parsed.call }),
		...(prepared.initialImages === undefined
			? {}
			: { images: prepared.initialImages }),
	});
}
