import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
/**
 * Tool Override Example - Demonstrates overriding built-in tools
 *
 * Extensions can register tools with the same name as built-in tools to replace them.
 * This is useful for:
 * - Adding logging or auditing to tool calls
 * - Implementing access control or sandboxing
 * - Routing tool calls to remote systems (e.g., pi-ssh-remote)
 * - Modifying tool behavior for specific workflows
 *
 * This example overrides the `read` tool to:
 * 1. Log all file access to a log file
 * 2. Block access to sensitive paths (e.g., .env files)
 * 3. Delegate to the original read implementation for allowed files
 *
 * Since no custom renderCall/renderResult are provided, the built-in renderer
 * is used automatically (syntax highlighting, line numbers, truncation warnings).
 *
 * Usage:
 *   pi -e ./tool-override.ts
 */

import {
	createReadToolDefinition,
	type ExtensionAPI,
	getAgentDir,
	withFileMutationQueue,
} from "@amazme/coding-agent";
import { readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join, resolve } from "path";

const LOG_FILE = join(getAgentDir(), "read-access.log");

// Paths that are blocked from reading
const BLOCKED_PATTERNS = [
	/\.env$/,
	/\.env\..+$/,
	/secrets?\.(json|yaml|yml|toml)$/i,
	/credentials?\.(json|yaml|yml|toml)$/i,
	/\/\.ssh\//,
	/\/\.aws\//,
	/\/\.gnupg\//,
];

function isBlockedPath(path: string): boolean {
	return BLOCKED_PATTERNS.some((pattern) => pattern.test(path));
}

async function logAccess(path: string, allowed: boolean, reason?: string) {
	const timestamp = new Date().toISOString();
	const status = allowed ? "ALLOWED" : "BLOCKED";
	const msg = reason ? ` (${reason})` : "";
	const line = `[${timestamp}] ${status}: ${path}${msg}\n`;

	try {
		await withFileMutationQueue(
			new NodeExecutionEnv({ cwd: process.cwd() }),
			LOG_FILE,
			async () => {
				await appendFile(LOG_FILE, line);
			},
			BACKGROUND_CONTEXT,
		);
	} catch {
		// Ignore logging errors
	}
}

export default function (pi: ExtensionAPI) {
	const read = createReadToolDefinition(process.cwd());
	pi.registerTool({
		...read,
		name: "read", // Same name as built-in - this will override it
		label: "read (audited)",
		description:
			"Read the contents of a file with access logging. Some sensitive paths (.env, secrets, credentials) are blocked.",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path } = params;
			const absolutePath = resolve(ctx.cwd, path);

			// Check if path is blocked
			if (isBlockedPath(absolutePath)) {
				await logAccess(absolutePath, false, "matches blocked pattern");
				const message = `Access denied: "${path}" matches a blocked pattern (sensitive file). This tool blocks access to .env files, secrets, credentials, and SSH/AWS/GPG directories.`;
				return {
					content: [
						{
							type: "text",
							text: message,
						},
					],
					structuredContent: message,
					details: undefined,
					isError: true,
				};
			}

			// Log allowed access
			await logAccess(absolutePath, true);

			return read.execute(toolCallId, params, signal, onUpdate, ctx);
		},

		// No renderCall/renderResult - uses built-in renderer automatically
		// (syntax highlighting, line numbers, truncation warnings, etc.)
	});

	// Also register a command to view the access log
	pi.registerCommand("read-log", {
		description: "View the file access log",
		handler: async (_args, ctx) => {
			try {
				const log = readFileSync(LOG_FILE, "utf-8");
				const lines = log.trim().split("\n").slice(-20); // Last 20 entries
				ctx.ui.notify(`Recent file access:\n${lines.join("\n")}`, "info");
			} catch {
				ctx.ui.notify("No access log found", "info");
			}
		},
	});
}
