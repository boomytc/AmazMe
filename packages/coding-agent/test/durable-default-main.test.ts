import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "./temp-dir.ts";

vi.mock("../src/durable/print.ts", () => ({
	runDurablePrint: vi.fn(async () => 0),
}));

import { main } from "../src/main.ts";
import { runDurablePrint } from "../src/durable/print.ts";

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
		vi.mocked(runDurablePrint).mockClear();
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

	it("uses Durable for a new print session when the runtime is not selected", async () => {
		await main(["--offline", "--print", "hello"]);
		expect(runDurablePrint).toHaveBeenCalledOnce();
		expect(vi.mocked(runDurablePrint).mock.calls[0]?.[0]).toMatchObject({ cwd, mode: "text", initialMessage: "hello" });
	});

	it("uses Durable for JSON mode by default", async () => {
		await main(["--offline", "--mode", "json", "hello"]);
		expect(runDurablePrint).toHaveBeenCalledOnce();
		expect(vi.mocked(runDurablePrint).mock.calls[0]?.[0]).toMatchObject({ cwd, mode: "json", initialMessage: "hello" });
	});
});
