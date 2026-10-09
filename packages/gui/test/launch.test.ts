import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { hostWorkingDirectory, resolveHostCli, resolveNodeExecutable, webHostLaunch } from "../src/launch.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/u, "");

describe("web host launch", () => {
	test("resolves the installed CLI through the application dependency", () => {
		expect(resolveHostCli()).toMatch(/coding-agent\/dist\/bundle\/cli\.js$/);
		expect(readFileSync(resolveHostCli(), "utf8").length).toBeGreaterThan(0);
	});

	test("spawns the installed web command on an OS-assigned port", () => {
		const launch = webHostLaunch({
			nodeExecutable: "/usr/bin/node",
			cliEntry: resolveHostCli(),
			cwd: repositoryRoot,
			env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" },
		});
		expect(launch.nodeExecutable).toBe("/usr/bin/node");
		expect(launch.cwd).toBe(repositoryRoot);
		expect(launch.args).toEqual([resolveHostCli(), "web", "--port", "0"]);
		expect(launch.env.AMAZME_EXPERIMENTAL).toBeUndefined();
		expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(launch.env.PATH).toBe("/usr/bin");
		for (const entry of launch.entries) {
			expect(readFileSync(entry, "utf8").length).toBeGreaterThan(0);
		}
	});

	test("keeps the development launcher on the same formal CLI", () => {
		const devWeb = readFileSync(new URL("../../../scripts/dev-web.mjs", import.meta.url), "utf8");
		expect(devWeb).toContain('join(repositoryRoot, "packages", "coding-agent", "src", "cli.ts")');
		expect(devWeb).toContain('join(repositoryRoot, "packages", "coding-agent", "src", "source-resolver.ts")');
	});

	test("selects Node without using Electron's executable", () => {
		expect(resolveNodeExecutable({ AMAZME_GUI_NODE: "/opt/node" })).toBe("/opt/node");
		expect(resolveNodeExecutable({ npm_node_execpath: "/missing/node" })).toBe("node");
		expect(resolveNodeExecutable({})).toBe("node");
	});

	test("runs the host in the launching directory unless a project is set", () => {
		expect(hostWorkingDirectory({}, "/repo")).toBe("/repo");
		expect(hostWorkingDirectory({ AMAZME_GUI_CWD: "/work" }, "/repo")).toBe("/work");
	});
});
