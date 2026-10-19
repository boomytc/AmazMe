/**
 * Process-level fixture for shutdown signals.
 *
 * `hang` / `ok` / `slow` use {@link closeAfterSignal}, the same wait server and web use.
 * `key` uses {@link ShutdownSignals.key}, the same call the default TUI's Ctrl-C key uses.
 */
import { writeSync } from "node:fs";
import { closeAfterSignal, installShutdownSignals } from "../src/utils/shutdown-signals.ts";

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
	void closeAfterSignal(new Promise<void>(() => {}), close, () => out("ready\n"))
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
