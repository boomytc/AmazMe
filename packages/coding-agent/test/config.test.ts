import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { findNodePackageDir, getAgentDir, getPackageDir } from "../src/config.ts";
import { createTempDir } from "./temp-dir.ts";

afterEach(() => vi.unstubAllEnvs());
test("package assets resolve past dist metadata to the installed package", () => {
	const directory = createTempDir("amazme-config-");
	const dist = join(directory, "dist");
	mkdirSync(dist);
	writeFileSync(join(directory, "package.json"), "{}");
	writeFileSync(join(dist, "package.json"), "{}");
	expect(findNodePackageDir(dist)).toBe(directory);
	vi.stubEnv("AMAZME_PACKAGE_DIR", directory);
	expect(getPackageDir()).toBe(directory);
});
test("the terminal preference root honors an explicit home-relative path", () => {
	vi.stubEnv("AMAZME_CODING_AGENT_DIR", "~/amazme-fixture");
	expect(getAgentDir()).toBe(join(homedir(), "amazme-fixture"));
});
