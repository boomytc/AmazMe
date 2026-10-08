import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { getOrThrow } from "@amazme/durable/env";
import { afterEach, describe, expect, it } from "vitest";
import { Connection } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";
import { daemon } from "./daemon.ts";

const connections: Connection[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const connection of connections.splice(0)) connection.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("daemon process transports", () => {
	it("uses supplied pipes for actual checked publication without a shell translation", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "amazme-transport-"));
		dirs.push(cwd);
		const connection = new Connection({
			start: (args) => spawn(daemon, [...args], { stdio: ["pipe", "pipe", "pipe"] }),
		});
		connections.push(connection);
		const env = new RemoteExecutionEnv({
			connection,
			id: "transport:test",
			cwd,
		});
		const first = getOrThrow(
			await env.writeFileChecked("file.txt", "one", { kind: "createIfAbsent" }, BACKGROUND_CONTEXT),
		);
		getOrThrow(
			await env.writeFileChecked(
				"file.txt",
				"two",
				{
					kind: "replaceIfVersion",
					revision: { path: first.path, version: first.version! },
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(readFileSync(join(cwd, "file.txt"), "utf8")).toBe("two");
	});

	it("retries a failed transport start without keeping a rejected ready promise", async () => {
		let starts = 0;
		const connection = new Connection({
			start: (args) => {
				if (++starts === 1) throw new Error("guest not ready");
				return spawn(daemon, [...args], { stdio: ["pipe", "pipe", "pipe"] });
			},
		});
		connections.push(connection);
		await expect(connection.info()).rejects.toThrow("guest not ready");
		expect((await connection.info()).protocol).toBe(1);
		expect(starts).toBe(2);
	});

	it("retires a transport that finishes starting after its owner closes", async () => {
		let finish = () => {};
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let exited: Promise<void> | undefined;
		const connection = new Connection({
			start: async (args) => {
				await gate;
				const child = spawn(daemon, [...args], {
					stdio: ["pipe", "pipe", "pipe"],
				});
				exited = new Promise((resolve) => {
					child.once("exit", () => resolve());
				});
				return child;
			},
		});
		connections.push(connection);
		const pending = connection.info().catch((error: unknown) => error);
		connection.close();
		finish();
		expect(await pending).toMatchObject({ message: "Connection closed" });
		await exited;
		await expect(connection.info()).rejects.toThrow("Connection closed");
	});
});
