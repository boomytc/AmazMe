import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceBuildPlan, buildWorkspaceDependencies } from "./build-workspace-dependencies.mjs";

async function fixture(manifests, run) {
	const root = await mkdtemp(join(tmpdir(), "workspace-build-plan-"));
	try {
		for (const [directory, manifest] of Object.entries(manifests)) {
			const path = join(root, "packages", directory);
			await mkdir(path, { recursive: true });
			await writeFile(join(path, "package.json"), JSON.stringify(manifest));
		}
		await run(root);
	} finally { await rm(root, { recursive: true, force: true }); }
}
const fixtures = {
	helper: { name: "@amazme/view-helper", scripts: { build: "build" } },
	web: { name: "@amazme/web", devDependencies: { "@amazme/view-helper": "*" }, scripts: { build: "build" } },
	gui: { name: "@amazme/gui", dependencies: { "@amazme/web": "*" }, scripts: { build: "build" } },
	unrelated: { name: "@amazme/unrelated", scripts: { build: "build" } },
};
test("orders the complete target closure, including build-time workspace dependencies, without unrelated packages", async () => {
	await fixture(fixtures, async (root) => {
		assert.deepEqual(await workspaceBuildPlan(root, ["@amazme/gui"]), [
			{ name: "@amazme/view-helper", script: "build" },
			{ name: "@amazme/web", script: "build" }, { name: "@amazme/gui", script: "build" },
		]);
		const calls = [];
		await buildWorkspaceDependencies(root, ["@amazme/gui"], (name, script) => { calls.push([name, script]); return 0; });
		assert.deepEqual(calls, [["@amazme/view-helper", "build"], ["@amazme/web", "build"], ["@amazme/gui", "build"]]);
	});
});
test("stops after a dependency failure and rejects cycles and unknown targets", async () => {
	await fixture(fixtures, async (root) => {
		const calls = [];
		await assert.rejects(buildWorkspaceDependencies(root, ["@amazme/gui"], (name, script) => {
			calls.push(name); return 2;
		}), /Workspace build failed: @amazme\/view-helper/);
		assert.deepEqual(calls, ["@amazme/view-helper"]);
		await assert.rejects(workspaceBuildPlan(root, ["missing"]), /Unknown workspace/);
	});
	await fixture({ a: { name: "a", dependencies: { b: "*" } }, b: { name: "b", dependencies: { a: "*" } } }, async (root) => {
		await assert.rejects(workspaceBuildPlan(root, ["a"]), /dependency cycle/);
	});
});
