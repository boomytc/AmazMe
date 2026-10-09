#!/usr/bin/env node

// Development launcher for the web client slice. It runs the `web` command
// straight from TypeScript sources through the resolver that slice already uses, so no
// build is needed while iterating. This is not a release entrypoint.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");
const cliEntry = join(repositoryRoot, "packages", "coding-agent", "src", "cli.ts");
const sourceResolver = join(repositoryRoot, "packages", "coding-agent", "src", "source-resolver.ts");

// One fixed port keeps the page URL stable across restarts: a reload is enough after a
// stylesheet edit, and the browser tab survives every relaunch of this command.
const devPort = 4310;

const usage = `Usage: node scripts/dev-web.mjs [--port <port>] [web options]

Serves the web client from TypeScript sources and prints the loopback URL to open. The page
stylesheets are read from disk on every request, so a browser reload shows a CSS edit. The
document and the page bundle are read when the host starts, so restart this command after
editing index.html or page.ts.

Options:
  --port <port>  Loopback port (default ${devPort}; 0 lets the OS assign one)
  -h, --help     Show this message

Every other option goes to \`amazme web\` (--server-id, --session-dir, ...).`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
	console.log(usage);
	process.exit(0);
}
const chosenPort = args.some((argument) => argument === "--port" || argument.startsWith("--port="));
const forwarded = chosenPort ? args : [...args, "--port", String(devPort)];

const child = spawn(process.execPath, ["--import", sourceResolver, cliEntry, "web", ...forwarded], {
	cwd: repositoryRoot,
	env: { ...process.env },
	stdio: "inherit",
});
// `Ctrl+C` reaches the host by itself: it shares this process group. A signal aimed at this
// launcher alone does not, and a host left behind keeps the port busy, so forward the two
// signals a supervisor is expected to handle.
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));

child.once("exit", (code, signal) => {
	process.exitCode = signal === null ? (code ?? 1) : 1;
});
