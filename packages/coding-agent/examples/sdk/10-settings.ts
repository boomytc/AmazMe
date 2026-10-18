/**
 * Settings.
 *
 * Pass a SettingsManager to share compaction, retry, and tool defaults with the CLI.
 */

import { createDurableSession, SettingsManager, getAgentDir } from "@amazme/coding-agent";

const settingsManager = SettingsManager.create(process.cwd(), getAgentDir());
const session = await createDurableSession({
	settingsManager,
	noSession: true,
});

try {
	await session.prompt("Say hello in one sentence.");
} finally {
	await session.dispose();
}
