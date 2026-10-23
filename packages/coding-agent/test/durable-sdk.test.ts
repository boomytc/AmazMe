import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableSession } from "../src/durable/sdk.ts";
import { createTempDir } from "./temp-dir.ts";

describe("durable SDK facade", () => {
	let directory: string;

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("refuses to open an old durable session", async () => {
		directory = createTempDir("amazme-durable-sdk-");
		const cwd = join(directory, "project");
		await mkdir(cwd);
		await expect(createDurableSession({ cwd, noSession: true })).rejects.toThrow("old_session_runtime_removed");
	});
});
