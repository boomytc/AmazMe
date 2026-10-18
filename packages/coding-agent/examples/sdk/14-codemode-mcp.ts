/**
 * MCP.
 *
 * The Durable runtime connects MCP servers from settings unless `noMcp` is set.
 * Native facet plugins replace inline extension factories.
 */

import { createDurableSession, SettingsManager, getAgentDir } from "@amazme/coding-agent";

const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
const session = await createDurableSession({
	settingsManager,
	noSession: true,
});

try {
	await session.prompt("Which tools can you use?");
} finally {
	await session.dispose();
}
