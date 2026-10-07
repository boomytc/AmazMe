import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	hostWorkingDirectory,
	repositoryRootFromModule,
	resolveNodeExecutable,
	webHostLaunch,
} from "../src/launch.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/u, "");

describe("web host launch", () => {
	test("finds the checkout from the gui module", () => {
		expect(repositoryRootFromModule(new URL("../src/launch.ts", import.meta.url))).toBe(repositoryRoot);
		expect(repositoryRootFromModule("file:///repo/packages/gui/dist/main.js")).toBe("/repo");
	});

	test("spawns the experimental web command on an OS-assigned port", () => {
		const launch = webHostLaunch({
			nodeExecutable: "/usr/bin/node",
			repositoryRoot,
			cwd: repositoryRoot,
			env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" },
		});
		expect(launch.nodeExecutable).toBe("/usr/bin/node");
		expect(launch.cwd).toBe(repositoryRoot);
		expect(launch.args).toEqual([
			"--import",
			join(repositoryRoot, "packages/coding-agent/src/experimental/source-resolver.ts"),
			join(repositoryRoot, "packages/coding-agent/src/experimental/cli.ts"),
			"web",
			"--port",
			"0",
		]);
		expect(launch.env.AMAZME_EXPERIMENTAL).toBe("1");
		expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(launch.env.PATH).toBe("/usr/bin");
		for (const entry of launch.entries) {
			expect(readFileSync(entry, "utf8").length).toBeGreaterThan(0);
		}
	});

	test("uses the same source entry as the web dev script", () => {
		const devWeb = readFileSync(new URL("../../../scripts/dev-web.mjs", import.meta.url), "utf8");
		expect(devWeb).toContain('join(repositoryRoot, "packages", "coding-agent", "src", "experimental", "cli.ts")');
		expect(devWeb).toContain(
			'join(repositoryRoot, "packages", "coding-agent", "src", "experimental", "source-resolver.ts")',
		);
	});

	test("selects Node without using Electron's executable", () => {
		expect(resolveNodeExecutable({ AMAZME_GUI_NODE: "/opt/node" })).toBe("/opt/node");
		expect(resolveNodeExecutable({ npm_node_execpath: "/missing/node" })).toBe("node");
		expect(resolveNodeExecutable({})).toBe("node");
	});

	test("runs the host in the checkout unless a project directory is set", () => {
		expect(hostWorkingDirectory({}, "/repo")).toBe("/repo");
		expect(hostWorkingDirectory({ AMAZME_GUI_CWD: "/work" }, "/repo")).toBe("/work");
	});
});
