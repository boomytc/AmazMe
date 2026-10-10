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
	ai: { name: "@amazme/ai", scripts: { build: "online", "build:offline": "offline" } },
	durable: { name: "@amazme/durable", dependencies: { "@amazme/ai": "*" }, scripts: { build: "build" } },
	web: { name: "@amazme/web", devDependencies: { "@amazme/durable": "*" }, scripts: { build: "build" } },
	gui: { name: "@amazme/gui", dependencies: { "@amazme/web": "*" }, scripts: { build: "build" } },
	unrelated: { name: "@amazme/unrelated", scripts: { build: "build" } },
};
test("orders the complete target closure, including build-time workspace dependencies, without unrelated packages or AI refresh", async () => {
	await fixture(fixtures, async (root) => {
		assert.deepEqual(await workspaceBuildPlan(root, ["@amazme/gui"]), [
			{ name: "@amazme/ai", script: "build:offline" }, { name: "@amazme/durable", script: "build" },
			{ name: "@amazme/web", script: "build" }, { name: "@amazme/gui", script: "build" },
		]);
		const calls = [];
		await buildWorkspaceDependencies(root, ["@amazme/gui"], (name, script) => { calls.push([name, script]); return 0; });
		assert.equal(calls[0][1], "check:model-data");
		assert.ok(!calls.some(([, script]) => script === "hydrate-model-data"));
	});
});
test("missing model data fails before building unless hydration was explicitly authorized", async () => {
	await fixture(fixtures, async (root) => {
		const calls = [];
		const run = (name, script) => { calls.push([name, script]); return script === "check:model-data" ? 1 : 0; };
		await assert.rejects(buildWorkspaceDependencies(root, ["@amazme/gui"], run), /缺少模型目录/);
		assert.equal(calls.length, 1);
		calls.length = 0;
		await buildWorkspaceDependencies(root, ["@amazme/gui"], run, true);
		assert.equal(calls[1][1], "hydrate-model-data");
	});
});
test("stops after a dependency failure and rejects cycles and unknown targets", async () => {
	await fixture(fixtures, async (root) => {
		const calls = [];
		await assert.rejects(buildWorkspaceDependencies(root, ["@amazme/gui"], (name, script) => {
			calls.push(name); return script === "check:model-data" ? 0 : 2;
		}), /Workspace build failed: @amazme\/ai/);
		assert.deepEqual(calls, ["@amazme/ai", "@amazme/ai"]);
		await assert.rejects(workspaceBuildPlan(root, ["missing"]), /Unknown workspace/);
	});
	await fixture({ a: { name: "a", dependencies: { b: "*" } }, b: { name: "b", dependencies: { a: "*" } } }, async (root) => {
		await assert.rejects(workspaceBuildPlan(root, ["a"]), /dependency cycle/);
	});
});
