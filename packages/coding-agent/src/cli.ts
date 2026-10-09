#!/usr/bin/env node
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";
import { consumeInternalProcessRole } from "./host/process.ts";

setupCli();
const args = process.argv.slice(2);
async function run(): Promise<void> {
	try {
		const role = consumeInternalProcessRole();
		if (role === "server") await (await import("./host/server.ts")).runServerProcess(args);
		else if (role === "session-worker") await (await import("./host/session-worker.ts")).runSessionWorkerProcess(args);
		else if (role === "coordinator") await (await import("./host/coordinator.ts")).runCoordinatorProcess(args);
		else if (args[0] === "server" || args[0] === "client" || args[0] === "web") {
			await (await import("./host/commands.ts")).runHostCommand(args);
			if (args[0] === "client") process.exit(process.exitCode ?? 0);
		} else await main(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
void run();
