import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

async function start(): Promise<void> {
	const electron: unknown = createRequire(import.meta.url)("electron");
	if (typeof electron !== "string" || electron.length === 0) throw new Error("Electron executable is unavailable");
	const executable = electron;
	const args = [packageDirectory, ...process.argv.slice(2)];
	const child = spawn(executable, args, {
		stdio: "inherit", windowsHide: false,
		env: { ...process.env, AMAZME_NODE: process.env.AMAZME_NODE || process.execPath, INIT_CWD: process.env.INIT_CWD ?? process.cwd() },
	});
	let closed = false;
	child.once("error", (error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
	child.once("close", (code) => {
		closed = true;
		process.exitCode = code ?? 1;
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"] as const) {
		process.on(signal, () => { if (!closed) child.kill(signal); });
	}
}

// The child process owns the lifetime of this entry; its close handler sets the final exit code.
start().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
