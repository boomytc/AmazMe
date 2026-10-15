import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

it("preserves historical DeepSeek V4 fallback and current V4.1 catalog reasoning metadata", () => {
	const root = mkdtempSync(join(tmpdir(), "amazme-opencode-generation-"));
	try {
		const preloadPath = join(root, "mock-catalog.mjs");
		const outputPath = join(root, "catalog");
		// V4 Flash has left the live catalog. Exercise the actual generator with
		// its original metadata instead of requiring the service to list it forever.
		const catalog = {
			"opencode-go": {
				models: {
					"deepseek-v4-flash": { tool_call: true, reasoning: true },
					"deepseek-v4.1-flash": {
						tool_call: true,
						reasoning: true,
						reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
					},
				},
			},
		};
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return Response.json(catalog);\n` +
				`  if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision", limit: { context: 64000, output: 0 } } });\n` +
				`  if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });\n` +
				`  if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"scripts/generate-models.ts",
				"--json-only",
				"--json-output",
				outputPath,
			],
			{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(result.stderr).toBe("");
		const models = JSON.parse(readFileSync(join(outputPath, "providers/opencode-go.json"), "utf8")) as Record<
			string,
			Model<Api>
		>;
		expect(models["deepseek-v4-flash"]).toBeDefined();
		expect(getSupportedThinkingLevels(models["deepseek-v4-flash"])).toEqual(["off", "low", "high", "max"]);
		expect(models["deepseek-v4.1-flash"]).toBeDefined();
		expect(getSupportedThinkingLevels(models["deepseek-v4.1-flash"])).toEqual(["low", "high", "max"]);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
