import type { AuthResult, AuthType } from "@amazme/ai";
import { APP_COMMAND } from "../config.ts";
import type { Args } from "./args.ts";

export type AuthCommandKind = "check" | "api_key" | "bearer_token" | "login" | "logout";

export interface AuthCommand {
	kind: AuthCommandKind;
	args: string[];
	json: boolean;
	credentials: boolean;
	noRefresh: boolean;
	minExpiryMs?: number;
	authType?: AuthType;
}

export class AuthCommandError extends Error {}

const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	login: `${APP_COMMAND} auth login --provider <provider> [--method oauth|api-key]`,
	logout: `${APP_COMMAND} auth logout --provider <provider>`,
	check: `${APP_COMMAND} auth check --provider <provider> [--json] [--credentials] [--no-refresh]`,
	api_key: `${APP_COMMAND} auth print-api-key --provider <provider> [--model <model>]`,
	bearer_token: `${APP_COMMAND} auth print-bearer-token --provider <provider> [--model <model>] [--min-expiry <duration>]`,
};

export function getAuthCommandName(kind: AuthCommandKind): string {
	if (kind === "login" || kind === "logout") return `auth ${kind}`;
	return kind === "check" ? "auth check" : kind === "api_key" ? "auth print-api-key" : "auth print-bearer-token";
}

export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return AUTH_COMMAND_USAGE[kind];
}

export function isAuthCommandHelp(args: string[]): boolean {
	return (
		args[0] === "auth" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

export function printAuthCommandHelp(): void {
	console.log(`Usage:
  ${AUTH_COMMAND_USAGE.login}
  ${AUTH_COMMAND_USAGE.logout}
  ${APP_COMMAND} auth print-api-key [--provider <provider>] [--model <model>]
  ${APP_COMMAND} auth print-bearer-token [--provider <provider>] [--model <model>] [--min-expiry <duration>]
  ${APP_COMMAND} auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]

Login and logout require --provider. Login prompts in a terminal; keys are entered without echo and never accepted as command arguments. OAuth retains Pi's provider identity. Logout removes saved credentials; environment variables remain available.
Other auth commands require at least one of --provider or --model. Checks refresh expired OAuth credentials by default; --no-refresh prevents this. --credentials emits the credential, or includes it in JSON output.`);
}

export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	if (args[0] !== "auth") return undefined;

	const kind =
		args[1] === "check"
			? "check"
			: args[1] === "print-api-key"
				? "api_key"
				: args[1] === "print-bearer-token"
					? "bearer_token"
					: args[1] === "login" || args[1] === "logout" ? args[1] : undefined;
	if (!kind) {
		throw new AuthCommandError(
			`Unknown auth command "${args[1] ?? ""}". Use "${APP_COMMAND} auth --help".`,
		);
	}

	const commandArgs: string[] = [];
	let json = false;
	let credentials = false;
	let noRefresh = false;
	let minExpiryMs: number | undefined;
	let authType: AuthType | undefined;
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (kind === "login" || kind === "logout") {
			if (arg === "--method" && kind === "login") {
				const value = args[++index];
				if (authType || (value !== "oauth" && value !== "api-key"))
					throw new AuthCommandError("--method must occur once and be oauth or api-key");
				authType = value === "oauth" ? "oauth" : "api_key";
			} else if (arg === "--provider") {
				const value = args[++index];
				if (!value || value.startsWith("--") || commandArgs.length > 0)
					throw new AuthCommandError("--provider requires one provider ID");
				commandArgs.push(arg, value);
			} else {
				throw new AuthCommandError(`Use "${AUTH_COMMAND_USAGE[kind]}"; credentials are entered in the terminal.`);
			}
			continue;
		}
		if (arg === "--min-expiry") {
			if (kind !== "bearer_token")
				throw new AuthCommandError("--min-expiry is only supported by print-bearer-token");
			const value = args[++index];
			const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
			if (!match) throw new AuthCommandError("--min-expiry must use a duration such as 30m or 1h");
			const amount = Number(match[1]);
			const unit = match[2];
			minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
			continue;
		}
		if (arg === "--json" || arg === "--credentials" || arg === "--no-refresh") {
			if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`);
			if (arg === "--json") json = true;
			else if (arg === "--credentials") credentials = true;
			else noRefresh = true;
			continue;
		}
		commandArgs.push(arg);
	}

	return {
		kind, args: commandArgs, json, credentials, noRefresh,
		...(minExpiryMs === undefined ? {} : { minExpiryMs }),
		...(authType === undefined ? {} : { authType }),
	};
}

export function validateAuthCommandArgs(args: Args, kind: AuthCommandKind): { provider?: string; model?: string } {
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value;
		throw new AuthCommandError(`Unknown option --${option} for "${getAuthCommandName(kind)}".`);
	}
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		throw new AuthCommandError("Auth commands only accept --provider and --model");
	}
	if (kind === "login" || kind === "logout") {
		if (!provider || model) throw new AuthCommandError("Login and logout require --provider <provider>");
		return { provider };
	}
	if (kind === "check") {
		if (!provider && !model) {
			throw new AuthCommandError("Auth checks require --provider <provider> or --model <model>");
		}
		return { provider, model };
	}
	if (!provider && !model) {
		throw new AuthCommandError("Credential printing requires --provider <provider> or --model <model>");
	}
	return { provider, model };
}

export function getAuthCredential(auth: AuthResult | undefined): string | undefined {
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}
