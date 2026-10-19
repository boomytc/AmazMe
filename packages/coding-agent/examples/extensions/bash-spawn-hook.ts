/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   pi -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@amazme/coding-agent";
import { createBashToolDefinition } from "@amazme/coding-agent";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashToolDefinition(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, AMAZME_SPAWN_HOOK: "1" },
		}),
	});

	pi.registerTool({
		...bashTool,
		// The session context carries the artifact directory for the full output of long commands.
		execute: async (id, params, signal, onUpdate, ctx) => {
			return bashTool.execute(id, params, signal, onUpdate, ctx);
		},
	});
}
