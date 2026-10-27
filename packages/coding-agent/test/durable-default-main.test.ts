import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "./temp-dir.ts";

vi.mock("../src/modes/headless/run.ts", () => ({
	runPythonHeadless: vi.fn(async () => 0),
}));

import { main } from "../src/main.ts";
import { runPythonHeadless } from "../src/modes/headless/run.ts";

describe("default headless runtime", () => {
	let directory: string;
	let cwd: string;
	let profile: string;
	const tty = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));

	beforeEach(async () => {
		directory = createTempDir("amazme-durable-default-");
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
		vi.mocked(runPythonHeadless).mockClear();
		vi.stubEnv("AMAZME_DURABLE_TUI", "");
	});

	afterEach(async () => {
		[process.stdin, process.stdout].forEach((stream, index) => {
			const descriptor = tty[index];
			if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
			else Object.defineProperty(stream, "isTTY", descriptor);
		});
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("uses the Python host for a new print session", async () => {
		await main(["--offline", "--print", "hello"]);
		expect(runPythonHeadless).toHaveBeenCalledOnce();
		expect(vi.mocked(runPythonHeadless).mock.calls[0]?.[0]).toMatchObject({ cwd, mode: "text", prompt: "hello" });
		expect(vi.mocked(runPythonHeadless).mock.calls[0]?.[0].workspace).toBeUndefined();
	});

	it("uses the Python host for JSON mode", async () => {
		await main(["--offline", "--mode", "json", "hello"]);
		expect(runPythonHeadless).toHaveBeenCalledOnce();
		expect(vi.mocked(runPythonHeadless).mock.calls[0]?.[0]).toMatchObject({ cwd, mode: "json", prompt: "hello" });
		expect(vi.mocked(runPythonHeadless).mock.calls[0]?.[0].workspace).toBeUndefined();
	});

	it("keeps the Python host for print when AMAZME_DURABLE_TUI is set", async () => {
		vi.stubEnv("AMAZME_DURABLE_TUI", "1");
		await main(["--offline", "--print", "hello"]);
		expect(runPythonHeadless).toHaveBeenCalledOnce();
		expect(vi.mocked(runPythonHeadless).mock.calls[0]?.[0]).toMatchObject({ cwd, mode: "text", prompt: "hello" });
		expect(vi.mocked(runPythonHeadless).mock.calls[0]?.[0].workspace).toBeUndefined();
	});
});
