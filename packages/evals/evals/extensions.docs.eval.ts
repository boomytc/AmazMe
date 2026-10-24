import { createHash } from "node:crypto";
import { z } from "zod";
import { describeEval, StructuredOutputJudge, ToolCallJudge } from "vitest-evals";
import { createDocumentationEvalHarness, DOCUMENTATION_EVAL_TOOLS } from "../src/harness.ts";
const tool = `plugin_${createHash("sha256")
	.update(`${"e".repeat(32)}\nhello`)
	.digest("hex")
	.slice(0, 20)}`;
const Result = z.object({
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	is_error: z.literal(false),
});
const harness = createDocumentationEvalHarness({
	pluginEntry: "plugin.py",
	tools: [...DOCUMENTATION_EVAL_TOOLS, "plugin_*"],
	output: ({ response, session }) => {
		const event = session.events.find((item) => item.type === "tool_result" && item.name === tool && !item.error);
		const parsed = Result.safeParse(event?.type === "tool_result" ? event.content : null);
		return {
			response,
			toolLoaded: parsed.success,
			toolResult: parsed.success ? parsed.data.content.map((item) => item.text).join("\n") : null,
		};
	},
});
describeEval(
	"Create and use a Python tool extension",
	{
		harness,
		judgeThreshold: null,
		judges: [
			StructuredOutputJudge({
				expected: { response: "Hello, Bob!", toolLoaded: true, toolResult: "Hello, Bob!" },
				match: "strict",
				allowExtras: false,
			}),
			ToolCallJudge({ expectedTools: [{ name: tool, arguments: { name: "Bob" } }] }),
		],
	},
	(it) => {
		it("creates and invokes the extension", async ({ run }) => {
			await run([
				{
					type: "prompt",
					content:
						"Write plugin.py in the workspace for AmazMe Python. Use a setup(api) factory to register a hello tool that takes a name and returns a greeting; Bob must return Hello, Bob!. The host will load this file after this turn.",
				},
				{
					type: "prompt",
					content: "Use the hello tool to greet Bob. Respond with exactly the greeting and nothing else.",
				},
			]);
		});
	},
);
