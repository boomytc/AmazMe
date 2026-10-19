import chalk from "chalk";
import { cli } from "../cli/host/cli.ts";
import type { ClientCommand } from "../cli/host/commands/client.ts";
import type { ServerCommand } from "../cli/host/commands/server.ts";
import type { WebCommand } from "../cli/host/commands/web.ts";
import { runClient } from "./client.ts";
import { runClientTui } from "./client-tui.ts";
import type { RadiusRelayHostStatus } from "./radius-relay.ts";
import { closeWhenSignaled, startForegroundServer } from "./server.ts";
import { startWebHost, type WebHost } from "./web/host.ts";
import { watchDesktopParent } from "./desktop-parent.ts";

async function runServerCommand(command: ServerCommand): Promise<void> {
	let previousRelayStatus = "";
	let relayOutputReady = false;
	let pendingRelayStatus: RadiusRelayHostStatus | undefined;
	const reportRelayStatus = (status: RadiusRelayHostStatus): void => {
		const description =
			status.status === "connected"
				? "connected"
				: status.status === "not_authenticated"
					? "not connected; local only"
					: status.status === "retrying"
						? `reconnecting: ${status.error}`
						: "connecting";
		if (description === previousRelayStatus || status.status === "connecting") return;
		previousRelayStatus = description;
		console.log(`Radius: ${description}`);
	};
	const runtime = await startForegroundServer({
		serverId: command.serverId,
		sessionDir: command.sessionDir,
		provider: command.provider,
		model: command.model,
		pluginPackages: command.pluginPackages ?? [],
		relayAuth: command.auth,
		onRelayStatus(status) {
			if (relayOutputReady) reportRelayStatus(status);
			else pendingRelayStatus = status;
		},
	});
	// `Socket:` tells a supervisor the server is ready, so it is printed only after the signal listeners are installed.
	await closeWhenSignaled(runtime.closed, () => runtime.close(), () => {
		console.log(`Server: ${runtime.serverId}`);
		console.log(`Socket: ${runtime.socketPath}`);
		relayOutputReady = true;
		if (pendingRelayStatus !== undefined) reportRelayStatus(pendingRelayStatus);
	});
	process.exit(process.exitCode ?? 0);
}

async function runClientCommand(command: ClientCommand): Promise<void> {
	if (command.prompt === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true) {
		await runClientTui(command);
		return;
	}
	const result = await runClient(command);
	if (result.kind === "attached") {
		console.log(`${result.serverId}\t${result.sessionId}\tattached`);
		return;
	}
	if (result.kind === "prompted") {
		console.log(result.text);
		return;
	}
	for (const session of result.sessions) console.log(`${session.serverId}\t${session.sessionId}`);
}

async function runWebCommand(command: WebCommand): Promise<void> {
	let parentClosed = false;
	let finishParent: (() => void) | undefined;
	const stopParent = watchDesktopParent(() => {
		parentClosed = true;
		finishParent?.();
	});
	let host: WebHost | undefined;
	let finished = false;
	try {
		const running = await startWebHost({
			...(command.port === undefined ? {} : { port: command.port }),
			...(command.serverId === undefined ? {} : { serverId: command.serverId }),
			...(command.sessionDir === undefined ? {} : { sessionDir: command.sessionDir }),
			...(command.pluginPackages === undefined ? {} : { pluginPackages: command.pluginPackages }),
		});
		host = running;
		if (parentClosed) {
			finished = true;
			return;
		}
		// The launch lines tell the desktop app the host is ready, so they follow the signal listeners.
		await closeWhenSignaled(running.closed, () => running.close(), (finish) => {
			finishParent = finish;
			for (const line of webLaunchLines(running)) console.log(line);
		});
		finished = true;
	} finally {
		stopParent();
		finishParent = undefined;
		await host?.close();
		if (finished) process.exit(process.exitCode ?? 0);
	}
}

/**
 * The launch line the operator (and the model) reads: canonical URL, mode, transport, and whether
 * this launch started the server or forwards its pages to one that was already running.
 */
export function webLaunchLines(
	host: Pick<WebHost, "url" | "mode" | "serverId" | "webSocketUrl" | "ownsServer" | "socketPath">,
): string[] {
	return [
		`Web: ${host.url}`,
		`Mode: ${host.mode}`,
		`WebSocket: ${host.webSocketUrl}`,
		`Server: ${host.serverId} (${host.ownsServer ? "started" : "already running"})`,
		`Socket: ${host.socketPath}`,
	];
}

/** Host commands share the formal CLI, with lazy dispatch from its entrypoint. */
export async function runHostCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "server" && args[0] !== "client" && args[0] !== "web") {
		return false;
	}
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			`Usage: amazme ${args[0]} [options]\n\nHost and client commands use the installed runtime.\nserver: --server-id <uuid> --session-dir <path> --model <provider/model> -e <plugin>\nweb: --port <0-65535> --server-id <uuid> --session-dir <path> -e <plugin>\nclient: --connect <unix:///path|radius://uuid> --session-id <id> [prompt]`,
		);
		return true;
	}
	try {
		const result = await cli.execute(args, {
			runServer: runServerCommand,
			runClient: runClientCommand,
			runWeb: runWebCommand,
		});
		if (!result.ok) {
			for (const error of result.errors) console.error(chalk.red(`Error: ${error}`));
			process.exitCode = 1;
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
