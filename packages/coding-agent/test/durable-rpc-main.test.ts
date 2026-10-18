import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/modes/rpc/durable-rpc.ts", () => ({
	runDurableRpc: vi.fn(async () => undefined),
}));

import { main } from "../src/main.ts";
import { runDurableRpc } from "../src/modes/rpc/durable-rpc.ts";

describe("durable RPC entry wiring", () => {
	let directory: string;
	let cwd: string;
	let profile: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-durable-rpc-main-"));
		cwd = join(directory, "project");
		profile = join(directory, "profile");
		await mkdir(cwd);
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", profile);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		vi.mocked(runDurableRpc).mockClear();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("opens RPC on the durable runtime", async () => {
		await main(["--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp"]);
		expect(runDurableRpc).toHaveBeenCalledOnce();
		expect(vi.mocked(runDurableRpc).mock.calls[0]?.[0]).toMatchObject({ cwd, noSession: true, noExtensions: true, noMcp: true });
	});
});
