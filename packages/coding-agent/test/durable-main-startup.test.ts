import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";
import { runOwnedPythonInteractive } from "../src/modes/interactive/session.ts";
import { createTempDir } from "./temp-dir.ts";

vi.mock("../src/modes/interactive/session.ts", () => ({
	runOwnedPythonInteractive: vi.fn(async () => {}),
	runPythonSessionTui: vi.fn(async () => {}),
}));

describe("main's default interactive startup", () => {
	let directory: string | undefined;
	const ttyDescriptors = [process.stdin, process.stdout].map((stream) =>
		Object.getOwnPropertyDescriptor(stream, "isTTY"),
	);

	afterEach(async () => {
		[process.stdin, process.stdout].forEach((stream, index) => {
			const descriptor = ttyDescriptors[index];
			if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
			else Object.defineProperty(stream, "isTTY", descriptor);
		});
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	});

	it("uses the Python host and does not open the durable TUI", async () => {
		directory = createTempDir("amazme-main-python-");
		const cwd = join(directory, "project");
		const profile = join(directory, "profile");
		await mkdir(cwd);
		await mkdir(profile);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		vi.stubEnv("AMAZME_STARTUP_BENCHMARK", "0");
		vi.stubEnv("AMAZME_DURABLE_TUI", "");
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		for (const stream of [process.stdin, process.stdout])
			Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		await main([]);
		expect(runOwnedPythonInteractive).toHaveBeenCalledWith({ cwd, prompt: "" });
	});

	it("keeps the Python host when AMAZME_DURABLE_TUI is set", async () => {
		directory = createTempDir("amazme-main-python-durable-flag-");
		const cwd = join(directory, "project");
		const profile = join(directory, "profile");
		await mkdir(cwd);
		await mkdir(profile);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		vi.stubEnv("AMAZME_STARTUP_BENCHMARK", "0");
		vi.stubEnv("AMAZME_DURABLE_TUI", "1");
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		for (const stream of [process.stdin, process.stdout])
			Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		await main([]);
		expect(runOwnedPythonInteractive).toHaveBeenCalledWith({ cwd, prompt: "" });
	});
});
