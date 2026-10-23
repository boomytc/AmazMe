import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "./temp-dir.ts";

vi.mock("../src/python-headless.ts", () => ({
	runPythonHeadless: vi.fn(async () => 0),
}));

import { main } from "../src/main.ts";
import { runPythonHeadless } from "../src/python-headless.ts";

describe("durable RPC entry wiring", () => {
	let directory: string;
	let cwd: string;
	let profile: string;

	beforeEach(async () => {
		directory = createTempDir("amazme-durable-rpc-main-");
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		vi.mocked(runPythonHeadless).mockClear();
		vi.stubEnv("AMAZME_DURABLE_TUI", "");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("opens RPC on the Python host", async () => {
		await main(["--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp"]);
		expect(runPythonHeadless).toHaveBeenCalledOnce();
		expect(vi.mocked(runPythonHeadless).mock.calls[0]?.[0]).toMatchObject({ cwd, mode: "rpc", workspace: "primary" });
	});

	it("keeps RPC on the Python host when AMAZME_DURABLE_TUI is set", async () => {
		vi.stubEnv("AMAZME_DURABLE_TUI", "1");
		await main(["--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp"]);
		expect(runPythonHeadless).toHaveBeenCalledOnce();
		expect(vi.mocked(runPythonHeadless).mock.calls[0]?.[0]).toMatchObject({ cwd, mode: "rpc", workspace: "primary" });
	});
});
