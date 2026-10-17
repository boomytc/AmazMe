import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Run the same installed modules as plugins and subprocesses, using the compiled Bun runtime.
async function main(): Promise<void> {
	await import(pathToFileURL(join(dirname(process.execPath), "dist", "bun", "cli.js")).href);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
