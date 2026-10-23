#!/usr/bin/env node
// First: silences warnings. node:sqlite warns while the module graph that imports it is being linked, before any of
// that graph runs, so everything that can reach node:sqlite (main and the host processes) is imported dynamically
// below, after this has run. The static imports here must stay free of SQLite.
import "./quiet-warnings.ts";
import { setupCli } from "./cli/setup.ts";
import { consumeInternalProcessRole } from "./host/process.ts";

setupCli();
const args = process.argv.slice(2);
async function run(): Promise<void> {
	try {
		const role = consumeInternalProcessRole();
		if (role !== undefined || args[0] === "web" || args[0] === "server" || args[0] === "client") {
			console.error("old_web_host_removed");
			console.error("网页由 Python 后端提供，不再启动旧宿主");
			process.exitCode = 1;
		} else await (await import("./main.ts")).main(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
void run();
