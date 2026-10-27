/**
 * RPC process entry: the Host client and run options only. No terminal screen, prompt
 * assembly, file attachment, or image pipeline is loaded for this mode.
 */
import { parseCliArgs, printHelp } from "../../cli/args.ts";
import { preparePythonRun, type ProductCommand } from "../../cli/run-options.ts";
import { VERSION } from "../../config.ts";
import { runPythonHeadless } from "./run.ts";

export async function runRpcEntry(
	args: string[],
	execute: ProductCommand,
	cwd = process.cwd(),
): Promise<void> {
	if (args.includes("--offline")) {
		process.env.AMAZME_OFFLINE = "1";
		process.env.AMAZME_SKIP_VERSION_CHECK = "1";
	}
	const parsed = parseCliArgs(args);
	if (parsed.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	if (parsed.help) {
		printHelp(process.stderr);
		return;
	}
	const prepared = await preparePythonRun(parsed, cwd, execute);
	if (!prepared) return;
	if (parsed.fileArgs.length) throw new Error("RPC mode does not accept @file arguments");
	const { session } = prepared;
	process.exitCode = await runPythonHeadless({
		...prepared.runOptions,
		...prepared.sessionOptions,
		mode: "rpc",
		cwd,
		prompt: parsed.messages.filter(Boolean).join("\n"),
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
