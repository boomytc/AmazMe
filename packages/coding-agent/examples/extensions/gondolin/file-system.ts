import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import type { DaemonTransport } from "@amazme/env";
import { Connection, packagedDaemon, RemoteExecutionEnv } from "@amazme/env";
import type { VM } from "@earendil-works/gondolin";

/** Use the actual guest daemon for both mounted host paths and the VM's private filesystem. */
export async function createGondolinFileSystem(vm: VM): Promise<RemoteExecutionEnv> {
	const machine = await vm.exec(["/bin/uname", "-m"]);
	const architecture = machine.stdout.trim();
	if (architecture !== "aarch64" && architecture !== "x86_64")
		throw new Error(`Unsupported Gondolin architecture: ${architecture}`);
	const binary =
		process.env.AMAZME_ENV_LINUX_BINARY ??
		packagedDaemon({
			platform: "linux",
			arch: architecture === "aarch64" ? "arm64" : "x64",
		});
	const guestBinary = "/tmp/amazme-env";
	await vm.fs.writeFile(guestBinary, await readFile(binary));
	const permissions = await vm.exec(["/bin/chmod", "700", guestBinary]);
	if (!permissions.ok) throw new Error(permissions.stderr);
	const connection = new Connection({
		start: (args) => {
			const controller = new AbortController();
			const process = vm.exec([guestBinary, ...args], {
				cwd: "/workspace",
				stdin: true,
				stdout: "pipe",
				stderr: "pipe",
				signal: controller.signal,
			});
			if (!process.stdout || !process.stderr) throw new Error("Gondolin did not provide daemon pipes");
			const events = new EventEmitter();
			const transport: DaemonTransport = Object.assign(events, {
				stdin: new Writable({
					write(chunk: Buffer, _encoding, done) {
						try {
							process.write(chunk);
							done();
						} catch (error) {
							done(error instanceof Error ? error : new Error(String(error)));
						}
					},
					final(done) {
						try { process.end(); done(); }
						catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
					},
				}),
				stdout: process.stdout,
				stderr: process.stderr,
				kill: () => controller.abort(),
			});
			void process.result.then(
				(result) => events.emit("exit", result.exitCode),
				(error: unknown) => events.emit("error", error instanceof Error ? error : new Error(String(error))),
			);
			return transport;
		},
	});
	try {
		await connection.info();
	} catch (error) {
		connection.close();
		throw error;
	}
	return new RemoteExecutionEnv({
		connection,
		id: `gondolin:${vm.id}`,
		cwd: "/workspace",
	});
}
