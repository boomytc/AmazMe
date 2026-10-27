#!/usr/bin/env node
import { parseArgs } from "./cli/args.ts";
import { APP_NAME } from "./config.ts";
import { runRpcEntry } from "./modes/headless/rpc.ts";
import { runPythonProductCommand } from "./python-product.ts";

process.title = `${APP_NAME}-rpc`;
process.env.AMAZME_CODING_AGENT = "true";
process.env.AI_AGENT = "AmazMe";

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	const forwarded = ["--mode", "rpc", ...args];
	if (parseArgs(forwarded).mode !== "rpc") {
		await (await import("./main.ts")).main(forwarded);
		return;
	}
	await runRpcEntry(args, runPythonProductCommand);
}

void run();
