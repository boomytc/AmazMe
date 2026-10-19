/**
 * Process-level fixture for shutdown signals.
 *
 * `hang` / `ok` / `slow` use {@link closeWhenSignaled}, the same wait server and web use.
 * `socket <path>` binds a Unix socket through {@link closeWhenSignaled} the way the internal server
 * does. It prints `binding` with the listeners already up, then waits for a `listen` line on stdin
 * before it listens, so a test can send a signal in the window before the socket exists.
 * `key` uses {@link ShutdownSignals.key}, the same call the default TUI's Ctrl-C key uses.
 */
import { writeSync } from "node:fs";
import { createServer } from "node:net";
import { closeWhenSignaled, installShutdownSignals } from "../src/utils/shutdown-signals.ts";

const mode = process.argv[2];
const keepAlive = setInterval(() => {}, 60_000);

function out(line: string): void {
	writeSync(1, line);
}

if (mode === "key") {
	const shutdown = installShutdownSignals(() => {
		out("signaled\n");
	});
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		// One chunk can carry both presses. `key` force-exits on the second, so the loop stops there.
		const presses = chunk.split("c").length - 1;
		for (let index = 0; index < presses; index += 1) shutdown.key(() => out("armed\n"));
	});
	process.stdin.resume();
	out("ready\n");
} else if (mode === "socket") {
	const path = process.argv[3];
	if (path === undefined) throw new Error("socket mode needs a path");
	const listenRequested = new Promise<void>((resolve) => {
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			if (chunk.includes("listen")) resolve();
		});
		process.stdin.resume();
	});
	void closeWhenSignaled(
		async () => {
			out("binding\n");
			await listenRequested;
			process.stdin.pause();
			const server = createServer();
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(path, resolve);
			});
			out("listening\n");
			const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
			return {
				closed,
				close: () =>
					new Promise<void>((resolve, reject) => {
						out("closing\n");
						// A Unix socket server unlinks its path on close.
						server.close((error) => (error ? reject(error) : resolve()));
					}),
			};
		},
		() => out("ready\n"),
	)
		.then(() => {
			clearInterval(keepAlive);
			process.exit(0);
		})
		.catch((error: unknown) => {
			clearInterval(keepAlive);
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		});
} else {
	const close = (): Promise<void> => {
		out("closing\n");
		if (mode === "hang") return new Promise<void>(() => {});
		if (mode === "slow") {
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					out("closed\n");
					resolve();
				}, 400);
			});
		}
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				out("closed\n");
				resolve();
			}, 150);
		});
	};
	// `arm` runs after the listeners are installed, so a signal sent on "ready" is always handled.
	void closeWhenSignaled(async () => ({ closed: new Promise<void>(() => {}), close }), () => out("ready\n"))
		.then(() => {
			clearInterval(keepAlive);
			process.exit(0);
		})
		.catch((error: unknown) => {
			clearInterval(keepAlive);
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		});
}
