/** Product presentation and input parsing; business operations belong to Python. */
import { resolve } from "node:path";
import { parseCliArgs, printHelp } from "./cli/args.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { preparePythonRun } from "./cli/run-options.ts";
import { VERSION } from "./config.ts";
import { runPythonProductCommand } from "./python-product.ts";

export { requestOptions } from "./cli/run-options.ts";

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
	if (args.includes("--offline")) {
		process.env.AMAZME_OFFLINE = "1";
		process.env.AMAZME_SKIP_VERSION_CHECK = "1";
	}
	if (await runPythonProductCommand(args, cwd)) return;
	const parsed = parseCliArgs(args);
	if (parsed.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	if (parsed.help) {
		printHelp(parsed.mode === "json" || parsed.mode === "rpc" ? process.stderr : process.stdout);
		return;
	}
	const prepared = await preparePythonRun(parsed, cwd, runPythonProductCommand);
	if (!prepared) return;
	const { session } = prepared;
	const interactive = !parsed.print && parsed.mode === undefined && process.stdin.isTTY && process.stdout.isTTY;
	const appearance = {
		...(parsed.tuiMode ? { tuiMode: parsed.tuiMode } : {}),
		...(parsed.useTheme ? { theme: parsed.useTheme } : {}),
		...(parsed.noThemes ? { noThemes: true } : {}),
		...(parsed.themes?.length ? { themes: parsed.themes.map((entry) => resolve(cwd, entry)) } : {}),
	};
	if (parsed.mode === "rpc" && parsed.fileArgs.length) throw new Error("RPC mode does not accept @file arguments");
	const stdinContent = interactive || parsed.mode === "rpc" ? undefined : await pipedInput();
	const files = parsed.fileArgs.length
		? await (await import("./cli/file-processor.ts")).processFileArguments(parsed.fileArgs, { autoResizeImages: false })
		: undefined;
	const message = buildInitialMessage({
		parsed,
		...(stdinContent === undefined ? {} : { stdinContent }),
		...(files === undefined ? {} : { fileText: files.text, fileImages: files.images }),
	});
	const initial = {
		prompt: [message.initialMessage, ...parsed.messages].filter(Boolean).join("\n"),
		...(message.initialImages === undefined ? {} : { images: message.initialImages }),
	};
	if (interactive) {
		const { runOwnedPythonInteractive, runPythonSessionTui } = await import("./modes/interactive/session.ts");
		if (parsed.pythonUrl && parsed.pythonToken)
			await runPythonSessionTui({
				...prepared.runOptions,
				...prepared.sessionOptions,
				...initial,
				...appearance,
				url: parsed.pythonUrl,
				token: parsed.pythonToken,
				workspace: parsed.workspace || "primary",
				...(session === undefined ? {} : { session }),
			});
		else
			await runOwnedPythonInteractive({
				...prepared.runOptions,
				...prepared.sessionOptions,
				...initial,
				...appearance,
				cwd,
				...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
				...(session === undefined ? {} : { session }),
			});
		return;
	}

	const { runPythonHeadless } = await import("./modes/headless/run.ts");
	process.exitCode = await runPythonHeadless({
		...prepared.runOptions,
		...prepared.sessionOptions,
		...initial,
		mode: parsed.mode === "rpc" ? "rpc" : parsed.mode === "json" ? "json" : "text",
		cwd,
		...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
		...(parsed.pythonUrl === undefined ? {} : { url: parsed.pythonUrl }),
		...(parsed.pythonToken === undefined ? {} : { token: parsed.pythonToken }),
		...(session === undefined ? {} : { session }),
		...(parsed.decision === undefined ? {} : { decision: parsed.decision }),
		...(parsed.request === undefined ? {} : { request: parsed.request }),
		...(parsed.approvalId === undefined ? {} : { approvalId: parsed.approvalId }),
		...(parsed.call === undefined ? {} : { call: parsed.call }),
	});
}
