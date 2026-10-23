import "../../src/quiet-warnings.ts";
import { setupCli } from "../../src/cli/setup.ts";

setupCli();
const args = process.argv.slice(2);

async function run(): Promise<void> {
	try {
		if (args[0] === "server" || args[0] === "client" || args[0] === "web") {
			throw new Error("legacy durable entry does not start the old web host");
		}
		await (await import("./legacy-durable-main.ts")).main(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

void run();
