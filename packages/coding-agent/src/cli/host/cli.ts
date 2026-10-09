import { Command } from "./command.ts";
import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";
import { type WebCommandContext, webCommand } from "./commands/web.ts";

interface HostCommandGroup {
	readonly command: "host";
}

export type CliContext = ServerCommandContext & ClientCommandContext & WebCommandContext;

const hostCommand = new Command<HostCommandGroup, CliContext>("host").build(() => ({
	ok: false,
	errors: ["Expected host command: server, client, or web"],
}));

export const cli = hostCommand.command(serverCommand).command(clientCommand).command(webCommand);
