/**
 * SSH tools use the same daemon-backed filesystem and checked publication as the local tools.
 * Usage: amazme -e ./ssh.ts --ssh user@host --ssh-cwd /project
 * The host must already be trusted in ~/.ssh/known_hosts. --ssh-binary supplies a matching daemon build if needed.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import type { ExtensionAPI } from "@amazme/coding-agent";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@amazme/coding-agent";
import { getOrThrow } from "@amazme/durable/env";
import { connectSsh, RemoteExecutionEnv } from "@amazme/env";

function bashOperations(files: RemoteExecutionEnv): BashOperations {
	return {
		exec: async (command, _cwd, { onData, signal, timeout }) => {
			const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
			const result = getOrThrow(
				await files.exec(
					command,
					{
						cwd: files.cwd,
						timeout,
						onOutput: (text) => onData(Buffer.from(text)),
					},
					context,
				),
			);
			return { exitCode: result.exitCode };
		},
	};
}

export default function (amazme: ExtensionAPI) {
	amazme.registerFlag("ssh", {
		description: "SSH host or user@host, already trusted in ~/.ssh/known_hosts",
		type: "string",
	});
	amazme.registerFlag("ssh-cwd", {
		description: "Remote working directory (defaults to daemon cwd)",
		type: "string",
	});
	amazme.registerFlag("ssh-binary", {
		description: "Local daemon binary matching the remote platform",
		type: "string",
	});
	const cwd = process.cwd();
	let files: RemoteExecutionEnv | undefined;
	const localRead = createReadToolDefinition(cwd);
	amazme.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const remote = files;
			const tool = remote === undefined ? localRead : createReadToolDefinition(remote.cwd, { fileSystem: remote });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});
	const localWrite = createWriteToolDefinition(cwd);
	amazme.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const remote = files;
			const tool = remote === undefined ? localWrite : createWriteToolDefinition(remote.cwd, { fileSystem: remote });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});
	const localEdit = createEditToolDefinition(cwd);
	amazme.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const remote = files;
			const tool = remote === undefined ? localEdit : createEditToolDefinition(remote.cwd, { fileSystem: remote });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});
	const localBash = createBashToolDefinition(cwd);
	amazme.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const remote = files;
			const tool =
				remote === undefined
					? localBash
					: createBashToolDefinition(remote.cwd, {
							operations: bashOperations(remote),
						});
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});
	amazme.on("session_start", async (_event, ctx) => {
		const target = amazme.getFlag("ssh");
		if (typeof target !== "string" || target.length === 0) return;
		const separator = target.lastIndexOf("@");
		const host = separator === -1 ? target : target.slice(separator + 1);
		const user = separator === -1 ? undefined : target.slice(0, separator);
		const binary = amazme.getFlag("ssh-binary");
		const connected = await connectSsh({
			host,
			user,
			hostKeyAlias: host,
			knownHostsFile: join(homedir(), ".ssh", "known_hosts"),
			binary: typeof binary === "string" ? binary : undefined,
		});
		try {
			const info = await connected.connection.info();
			const remoteCwd = amazme.getFlag("ssh-cwd");
			files?.connection.close();
			files = new RemoteExecutionEnv({
				connection: connected.connection,
				id: `ssh:${user ?? ""}@${host}`,
				cwd: typeof remoteCwd === "string" ? remoteCwd : info.cwd,
			});
			ctx.ui.setStatus("ssh", `SSH: ${host}:${files.cwd}`);
		} catch (error) {
			connected.connection.close();
			throw error;
		}
	});
	amazme.on("session_shutdown", () => {
		files?.connection.close();
		files = undefined;
	});
	amazme.on("user_bash", () => (files ? { operations: bashOperations(files) } : undefined));
	amazme.on("before_agent_start", (event) =>
		files
			? {
					systemPrompt: event.systemPrompt.replace(
						`Current working directory: ${cwd}`,
						`Current working directory: ${files.cwd} (SSH)`,
					),
				}
			: undefined,
	);
}
