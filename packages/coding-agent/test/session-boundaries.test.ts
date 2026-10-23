import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";
import { createTempDir } from "./temp-dir.ts";

describe("interactive storage selection boundary", () => {
	let directory: string;
	let profile: string;
	const streams = [process.stdin, process.stdout];
	const tty = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));

	beforeEach(async () => {
		directory = createTempDir("amazme-session-boundary-");
		const cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		vi.stubEnv("AMAZME_STARTUP_BENCHMARK", "0");
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		for (const stream of streams) Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
	});

	afterEach(async () => {
		streams.forEach((stream, index) => {
			const descriptor = tty[index];
			if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
			else Object.defineProperty(stream, "isTTY", descriptor);
		});
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it.each([
		[["--fork", "source-session"], "Unknown option --fork"],
		[["--session", "terminal.jsonl"], "old_session_migration_removed"],
		[["--session-id", "stable-session-id"], "Unknown option --session-id"],
		[["--no-session", "--continue"], "--no-session cannot be combined"],
		[["--no-session", "--resume"], "--no-session cannot be combined"],
	])("rejects %j before opening durable storage", async (args, diagnostic) => {
		const rejected = new Error("captured process.exit");
		const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw rejected; });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(main(["--offline", ...args])).rejects.toBe(rejected);
		expect(exit).toHaveBeenCalledWith(1);
		expect(error.mock.calls.flat().join("\n")).toContain(diagnostic);
		expect(existsSync(profile)).toBe(false);
	});
});
