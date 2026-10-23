import "../../src/quiet-warnings.ts";
import { setupCli } from "../../src/cli/setup.ts";

setupCli();
const args = process.argv.slice(2);

async function run(): Promise<void> {
	try {
		if (args[0] !== "server" && args[0] !== "client") {
			throw new Error("legacy host entry only starts server or client");
		}
		await (await import("../../src/host/commands.ts")).runHostCommand(args);
		if (args[0] === "client") process.exit(process.exitCode ?? 0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

void run();
