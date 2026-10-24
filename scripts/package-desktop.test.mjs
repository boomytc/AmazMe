import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runtimePackages, workspacePackages } from "./package-artifacts.mjs";
import { DESKTOP_PACKAGES } from "./package-desktop.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the desktop package closure does not include the old coding-agent host", () => {
	assert.deepEqual(DESKTOP_PACKAGES, ["@amazme/gui"]);
	const names = runtimePackages(workspacePackages(repoRoot), DESKTOP_PACKAGES).map((pkg) => pkg.manifest.name);
	assert.deepEqual(names, ["@amazme/web", "@amazme/gui"]);
});
