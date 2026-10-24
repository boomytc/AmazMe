import type { JsonValue } from "@vitest-evals/core";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createCodingAgentHarness,
	resolveDocumentationVariant,
	resolveModelSelection,
	runNativeEval,
} from "../src/harness.ts";
const model = { provider: "faux", id: "faux" };

describe("native Python harness", () => {
	it("requires an explicit complete model selection", () => {
		expect(resolveModelSelection(model, { AMAZME_PROVIDER: "openai", AMAZME_MODEL: "other" })).toEqual(model);
		expect(resolveModelSelection(undefined, { AMAZME_PROVIDER: " faux ", AMAZME_MODEL: " faux " })).toEqual(model);
		expect(() => resolveModelSelection(undefined, {})).toThrow("Select a harness model explicitly");
		expect(() => resolveDocumentationVariant("unknown")).toThrow("AMAZME_EVAL_VARIANT");
	});
	it.each(["without_docs", "with_docs"] as const)(
		"runs a real Python session with %s, without changing HOME",
		async (documentation) => {
			const home = process.env.HOME;
			const result = await runNativeEval("hello", { model, documentation, noTools: "all" });
			expect(result.response).toBe("已收到：hello");
			expect(result.errors).toEqual([]);
			expect(result.session.events).toEqual([
				{ type: "message", role: "user", content: "hello" },
				{ type: "message", role: "assistant", content: "已收到：hello" },
			]);
			expect(result.evidence).toMatchObject({ documentation, build_id: expect.stringMatching(/^[a-f0-9]{64}$/) });
			expect(result.usage.totalTokens).toBeGreaterThan(0);
			expect(process.env.HOME).toBe(home);
		},
	);
	it("loads an actual Python factory, invokes its alias, and reports its full tool transcript", async () => {
		const alias = `plugin_${createHash("sha256")
			.update(`${"e".repeat(32)}\nhello`)
			.digest("hex")
			.slice(0, 20)}`;
		const source = `from pydantic import BaseModel
from amazme_backend.plugin_api import PluginResult, ToolDefinition
class Greeting(BaseModel):
    name: str

def setup(api):
    def greet(call_id, args, ctx):
        return PluginResult(content=[{"type":"text","text":"Hello, " + args.name + "!"}])
    api.register_tool(ToolDefinition("hello", "Greeting", "Greet a name", Greeting, greet))
`;
		const harness = createCodingAgentHarness({
			model,
			pluginEntry: "plugin.py",
			workspaceFiles: { "plugin.py": source },
			tools: ["plugin_*"],
		});
		const artifacts: Record<string, JsonValue> = {};
		const result = await harness.run(
			[
				{ type: "prompt", content: "load" },
				{ type: "prompt", content: `/mcp ${JSON.stringify({ alias, arguments: { name: "Bob" } })}` },
			],
			{
				artifacts,
				setArtifact(key, value) {
					artifacts[key] = value;
				},
			},
		);
		expect(result.errors).toEqual([]);
		expect(result.session.events).toContainEqual(
			expect.objectContaining({ type: "tool_call", name: alias, arguments: { name: "Bob" } }),
		);
		expect(result.session.events).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				name: alias,
				content: expect.objectContaining({ content: [{ type: "text", text: "Hello, Bob!" }], is_error: false }),
			}),
		);
		expect(artifacts.nativeSessionJsonl).toContain("Hello, Bob!");
	});
	it("keeps errors observable and never grants a workspace traversal", async () => {
		const result = await runNativeEval("hello", { model, workspaceFiles: { "../escape": "invalid" } });
		expect(result.errors).toEqual(["eval_workspace_path"]);
	});
	it("waits for runner cleanup on cancellation", async () => {
		const controller = new AbortController();
		const pending = runNativeEval("/shell sleep 30", { model, tools: ["shell"] }, controller.signal);
		const timer = setTimeout(() => controller.abort(new Error("test_cancel")), 6000);
		try {
			await expect(pending).rejects.toThrow("test_cancel");
		} finally {
			clearTimeout(timer);
		}
	});
});
