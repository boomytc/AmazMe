import { createModels } from "@amazme/ai";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { AgentDoc, createRegistry, Harness, MemoryStorage } from "@amazme/durable";
import { afterEach, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { durableToolSelection } from "../src/core/tool-selection.ts";
import { createToolReloadTracker, reloadConversationResources } from "../src/durable/tool-activation.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.close(context)));
});

test("reload enables a newly saved tool, keeps a removed one, and reconnects MCP", async () => {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	harnesses.push(harness);
	const initial = durableToolSelection({}, undefined, undefined);
	const root = await harness.root(context, {
		init: async (tx, id) => {
			const agent = await tx.doc(AgentDoc, id);
			agent.tools = initial;
		},
	});
	const settings = SettingsManager.inMemory({ defaultTools: ["+ls", "-write"] });
	const tracker = createToolReloadTracker(initial);
	let connections = 0;
	let aligned = 0;
	await reloadConversationResources({
		context,
		settings,
		mcp: { reload: async () => { connections += 1; } },
		conversation: root,
		tracker,
		align: async () => { aligned += 1; },
	});
	await reloadConversationResources({
		context,
		settings,
		mcp: { reload: async () => { connections += 1; } },
		conversation: root,
		tracker,
		align: async () => { aligned += 1; },
	});
	const stored = await harness.snapshot(AgentDoc, root.id, context);
	const tools = stored?.tools;
	expect(Array.isArray(tools)).toBe(false);
	if (tools === undefined || Array.isArray(tools)) throw new Error("Expected an edited tool selection");
	expect(tools.add).toContain("ls");
	expect(tools.add).toContain("write");
	expect(tools.add?.filter((name) => name === "ls")).toEqual(["ls"]);
	expect(tools.remove ?? []).not.toContain("ls");
	expect(connections).toBe(2);
	expect(aligned).toBe(2);
});
