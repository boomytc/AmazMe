import { describe, expect, test } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";

describe("built-in tool system prompt contributions", () => {
	test.each([
		["bash", createBashToolDefinition],
		["powershell", createPowerShellToolDefinition],
	] as const)("keeps %s session-environment guidance conditional", (_name, createDefinition) => {
		const definition = createDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});
});
