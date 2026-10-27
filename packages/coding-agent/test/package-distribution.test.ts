import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the built client has no retired TS business runtime or public host export", async () => {
	const manifest: { exports: Record<string, unknown>; version: string } = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	expect(Object.keys(manifest.exports).sort()).toEqual([".", "./config", "./rpc-entry", "./update-manifest"]);
	const inputs: string[] = JSON.parse(readFileSync(new URL("../dist/bundle/inputs.json", import.meta.url), "utf8"));
	expect(inputs.length).toBeGreaterThan(0);
	for (const path of inputs)
		expect(path).not.toMatch(
			/packages\/(ai|durable|chord|agent|mcp|server)\/dist|coding-agent\/dist\/(host|durable|extensions)\//,
		);
	const { HostClient, CustomEditor } = await import("../dist/index.js");
	expect(HostClient).toBeTypeOf("function");
	expect(CustomEditor).toBeTypeOf("function");
	const version = execFileSync(
		process.execPath,
		[fileURLToPath(new URL("../dist/bundle/cli.js", import.meta.url)), "--version"],
		{ encoding: "utf8" },
	).trim();
	expect(version).toBe(manifest.version);
});

test.each([
	["--request", "request", "--approval-id", "approval"],
	["--call", "call"],
])("the RPC entry rejects a decision and message before connecting (%s)", (...target) => {
	const entry = fileURLToPath(new URL("../dist/bundle/rpc-entry.js", import.meta.url));
	const result = spawnSync(
		process.execPath,
		[entry, "--python-url", "http://127.0.0.1:1", "--python-token", "test", "--decision", "批准", ...target, "message"],
		{ encoding: "utf8", timeout: 5000 },
	);
	expect(result.status).toBe(1);
	expect(result.stderr).toBe("decision_target_conflict\n");
	expect(result.stdout).toBe("");
});

test.each(["text", "json"])("the RPC entry respects an explicit %s mode", (mode) => {
	const cli = fileURLToPath(new URL("../dist/bundle/cli.js", import.meta.url));
	const rpc = fileURLToPath(new URL("../dist/bundle/rpc-entry.js", import.meta.url));
	const options = { encoding: "utf8" as const, timeout: 5000 };
	const expected = spawnSync(process.execPath, [cli, "--mode", "rpc", "--mode", mode, "--help"], options);
	const actual = spawnSync(process.execPath, [rpc, "--mode", mode, "--help"], options);
	expect(actual.status).toBe(expected.status);
	expect(actual.stdout).toBe(expected.stdout);
	expect(actual.stderr).toBe(expected.stderr);
});
