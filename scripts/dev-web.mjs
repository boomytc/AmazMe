#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
if (!process.argv.slice(2).some(arg => ["--help", "-h"].includes(arg))) {
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build-workspace-dependencies.mjs", import.meta.url)), "@amazme/web"], { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
const child = spawn(process.execPath, ["--import", "./packages/coding-agent/src/source-resolver.ts",
	"./packages/coding-agent/src/cli.ts", "web", ...process.argv.slice(2)], {cwd:root, stdio:"inherit"});
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code, signal) => {
	process.off("SIGINT", interrupt);
	process.off("SIGTERM", terminate);
	process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
