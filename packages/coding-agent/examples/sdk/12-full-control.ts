/**
 * Explicit configuration.
 *
 * Discovery flags turn off skills, context files, prompt templates, themes, and plugins.
 */

import { createDurableSession, ModelRuntime, SettingsManager } from "@amazme/coding-agent";

const modelRuntime = await ModelRuntime.create();
if (process.env.MY_ANTHROPIC_KEY) {
	await modelRuntime.setRuntimeApiKey("anthropic", process.env.MY_ANTHROPIC_KEY);
}

const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

const session = await createDurableSession({
	cwd: process.cwd(),
	modelRuntime,
	settingsManager,
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	thinkingLevel: "off",
	systemPrompt: "You are a terse coding assistant.",
	noSkills: true,
	noContextFiles: true,
	noPromptTemplates: true,
	noThemes: true,
	noExtensions: true,
	noMcp: true,
	tools: ["read", "grep", "find", "ls"],
	noSession: true,
});

try {
	await session.prompt("Say hello in one sentence.");
} finally {
	await session.dispose();
}
