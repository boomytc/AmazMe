#!/usr/bin/env node
import { APP_NAME } from "./config.ts";

process.title = APP_NAME;
async function run(): Promise<void> {
	try {
		if (process.env.__AMAZME_INTERNAL_SPAWN !== undefined) throw new Error("internal_process_role_removed");
		await (await import("./main.ts")).main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
void run();
