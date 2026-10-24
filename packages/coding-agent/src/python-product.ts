/** Product commands use the same Python host as interactive and headless clients. */
import { spawn } from "node:child_process";
import { connectPythonHost } from "./python-session-tui.ts";
import { HostClient } from "./python-headless.ts";

const COMMANDS = new Set([
	"web",
	"server",
	"client",
	"models",
	"model",
	"accounts",
	"auth",
	"import",
	"export",
	"doctor",
	"workspaces",
	"resources",
]);

export async function runPythonProductCommand(
	args: readonly string[],
	cwd: string,
	options: { readonly input?: string; readonly quiet?: boolean } = {},
): Promise<boolean> {
	const command = args[0];
	if (!command || !COMMANDS.has(command)) return false;
	let url: string | undefined, token: string | undefined;
	const forwarded: string[] = [];
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--python-url" || argument === "--python-token") {
			const value = args[++index];
			if (!value || value.startsWith("--"))
				throw new Error("python_target_required");
			if (argument === "--python-url") url = value;
			else token = value;
		} else if (argument !== undefined) forwarded.push(argument);
	}
	if ((url === undefined) !== (token === undefined))
		throw new Error("python_target_required");
	if (command === "web" || command === "server") {
		// The local host selects a free loopback port; an existing profile keeps its current listener.
		if (
			forwarded.length &&
			(forwarded.length !== 2 ||
				forwarded[0] !== "--port" ||
				forwarded[1] !== "0")
		)
			throw new Error(
				"usage: amazme web|server [--port 0] [--python-url URL --python-token TOKEN]",
			);
		const host = await connectPythonHost({
			cwd,
			...(url === undefined ? {} : { url, token }),
		});
		if (command === "web") {
			const client = new HostClient(host.url, host.token);
			await client.bootstrap();
			const workspace = url ? "primary" : await client.selectWorkspace(cwd);
			process.stdout.write(`${await client.windowUrl(workspace)}\n`);
		} else process.stdout.write(`${host.url}/\n`);
		return true;
	}
	const host = await connectPythonHost({
		cwd,
		...(url === undefined ? {} : { url, token }),
	});
	const child = spawn(
		process.env.AMAZME_PYTHON_BACKEND || "amazme-backend",
		[
			"client",
			"--url",
			host.url,
			"--token",
			host.token,
			...(command === "client" ? [] : [command]),
			...forwarded,
		],
		{
			stdio: [
				options.input === undefined ? "inherit" : "pipe",
				options.quiet ? "ignore" : "inherit",
				"inherit",
			],
			cwd,
		},
	);
	if (options.input !== undefined) child.stdin?.end(options.input + "\n");
	const interrupted = (): void => {
		child.kill("SIGINT");
	};
	const terminated = (): void => {
		child.kill("SIGTERM");
	};
	process.on("SIGINT", interrupted);
	process.on("SIGTERM", terminated);
	try {
		process.exitCode = await new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) =>
				resolve(code ?? (signal === "SIGINT" ? 130 : 1)),
			);
		});
	} finally {
		process.off("SIGINT", interrupted);
		process.off("SIGTERM", terminated);
	}
	return true;
}
