#!/usr/bin/env node
import { appendFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const log = (value) =>
	appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(value)}\n`);
if (process.argv[2] === "check-permissions") {
	log({ event: "probe" });
	process.stdout.write(
		JSON.stringify({
			accessibility: false,
			screen_recording: false,
			host_bundle_id: "com.amazme.computer-use",
		}),
	);
} else {
	const socket = process.argv[process.argv.indexOf("--socket") + 1];
	const server = createServer((connection) => connection.end());
	server.listen(socket, () =>
		log({
			event: "host-started",
			socket,
			directoryMode: statSync(dirname(socket)).mode & 0o777,
		}),
	);
	process.stdin.resume();
	process.stdin.on("end", () =>
		server.close(() => {
			log({ event: "host-exited" });
			process.exit(0);
		}),
	);
}
