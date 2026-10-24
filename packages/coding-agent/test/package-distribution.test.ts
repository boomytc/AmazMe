import { execFileSync } from "node:child_process";
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
