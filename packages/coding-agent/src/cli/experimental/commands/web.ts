import { isServerId, type ServerId } from "@amazme/protocol";
import { Command, stringOption, valueOption } from "../command.ts";
import { unsupportedOptions } from "../command-options.ts";

export interface WebCommand {
	readonly command: "web";
	/** Loopback port. Omitted means an OS-assigned port. */
	readonly port?: number;
	readonly serverId?: ServerId;
	readonly sessionDir?: string;
}

export interface WebCommandContext {
	runWeb(command: WebCommand): void | Promise<void>;
}

const serverIdOption = valueOption("--server-id", (value) =>
	isServerId(value)
	? { ok: true, value }
	: { ok: false, error: `Invalid --server-id "${value}"; expected a lowercase UUIDv4` },
);
const portOption = valueOption("--port", (value) => {
	if (!/^\d+$/.test(value)) return { ok: false, error: `Invalid --port "${value}"; expected a port number` };
	const port = Number(value);
	return port >= 0 && port <= 65_535
		? { ok: true, value: port }
		: { ok: false, error: `Invalid --port "${value}"; expected 0-65535` };
});
const sessionDirOption = stringOption("--session-dir");

export const webCommand = new Command<WebCommand, WebCommandContext>("web")
	.option(portOption)
	.option(serverIdOption)
	.option(sessionDirOption)
	.build((input) => {
		const errors = unsupportedOptions("web", input);
		if (errors.length > 0) return { ok: false, errors };
		const port = input.value(portOption);
		const serverId = input.value(serverIdOption);
		const sessionDir = input.value(sessionDirOption);
		return {
			ok: true,
			command: {
				command: "web",
				...(port === undefined ? {} : { port }),
				...(serverId === undefined ? {} : { serverId }),
				...(sessionDir === undefined ? {} : { sessionDir }),
			},
		};
	})
	.action((command, context) => context.runWeb(command));
