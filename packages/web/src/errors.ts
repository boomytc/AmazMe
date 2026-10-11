import type { Locale } from "./locale.ts";
import type { MessageKey } from "./strings.ts";
import { translate } from "./strings.ts";

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
	not_found: "error.notFound", ENOENT: "error.notFound",
	permission_denied: "error.permission", EACCES: "error.permission", EPERM: "error.permission",
	not_directory: "error.notDirectory", ENOTDIR: "error.notDirectory",
	is_directory: "error.isDirectory", EISDIR: "error.isDirectory",
	not_observed: "error.readFirst", stale_version: "error.changed",
	not_supported: "error.unsupported", invalid: "error.invalid",
	unsupported_image: "error.unsupported", unknown: "error.execution",
	tool_unavailable: "error.toolUnavailable", invalid_arguments: "error.arguments",
	invalid_structured_output: "error.resultFormat", blocked: "error.blocked",
	aborted: "error.stopped", abandoned: "error.notStarted", interrupted: "error.interrupted",
	orphaned: "error.cannotResume", faulted: "error.execution",
	timeout: "error.timeout", ETIMEDOUT: "error.timeout", ERR_TIMED_OUT: "error.timeout",
	ECONNREFUSED: "error.connectionRefused", ERR_CONNECTION_REFUSED: "error.connectionRefused",
	ECONNRESET: "error.connectionLost", ERR_CONNECTION_RESET: "error.connectionLost",
	ENOTFOUND: "error.address", ERR_NAME_NOT_RESOLVED: "error.address",
	ERR_INTERNET_DISCONNECTED: "error.offline",
	invalid_api_key: "error.credentials", authentication_error: "error.credentials",
	rate_limit_exceeded: "error.rateLimit", context_length_exceeded: "error.contextLimit",
	insufficient_quota: "error.quota", model_not_found: "error.modelUnavailable",
};

/** Known codes have page copy; unknown provider and extension messages remain useful as written. */
export function errorCodeCopy(locale: Locale, code: string): string | undefined {
	return Object.hasOwn(ERROR_KEYS, code) ? translate(locale, ERROR_KEYS[code]!) : undefined;
}

/** Only recognize error envelopes. Never rewrite commands, file contents, or ordinary tool output. */
export function errorMessageCopy(locale: Locale, message: string): string {
	const bare = errorCodeCopy(locale, message);
	if (bare !== undefined) return bare;
	if (["Request was aborted", "Operation aborted", "Command aborted"].includes(message)) return translate(locale, "error.stopped");
	if (message === "No model is configured") return translate(locale, "error.noModel");
	if (message === "no credentials") return translate(locale, "error.credentials");
	if (message === "Read the existing file before replacing it") return translate(locale, "error.readFirst");
	if (message === "Another writer created the file; read it before replacing it") return translate(locale, "error.changed");
	const envelope = /^(?:\d{3}\s+)?(\{[\s\S]*\})$/u.exec(message);
	if (envelope !== null) {
		try {
			const parsed: unknown = JSON.parse(envelope[1]!);
			if (parsed !== null && typeof parsed === "object" && "error" in parsed && parsed.error !== null && typeof parsed.error === "object") {
				const error = parsed.error as Record<string, unknown>;
				const copy = typeof error.code === "string" ? errorCodeCopy(locale, error.code) : undefined;
				const typed = copy ?? (typeof error.type === "string" ? errorCodeCopy(locale, error.type) : undefined);
				if (typed !== undefined) {
					const detail = typeof error.message === "string" ? errorMessageCopy(locale, error.message) : "";
					return detail.length === 0 || detail === typed ? typed : `${typed}: ${detail}`;
				}
			}
		} catch {
			// Malformed or unfamiliar provider output remains intact.
		}
	}
	let match = /^Could not edit file: ([\s\S]+)\. Error code: ([a-z_]+)\.$/u.exec(message);
	if (match) return translate(locale, "error.editFile", { path: match[1]!, reason: errorCodeCopy(locale, match[2]!) ?? match[2]! });
	match = /^Model (.+) is not available$/u.exec(message);
	if (match) return `${translate(locale, "error.modelUnavailable")}: ${match[1]}`;
	match = /^Command timed out after ([\d.]+) seconds$/u.exec(message);
	if (match) return translate(locale, "error.commandTimeout", { seconds: match[1]! });
	match = /^(.+) changed since it was read; read it again$/u.exec(message);
	if (match) return `${translate(locale, "error.changed")}: ${match[1]}`;
	match = /^Read (.+) before editing it$/u.exec(message);
	if (match) return `${translate(locale, "error.readFirst")}: ${match[1]}`;
	// Node retains the affected paths after the operation name (including rename destinations).
	return message.replace(/^((?:[^'"\n/:]+[:：]\s+)?)(ENOENT|EACCES|EPERM|ENOTDIR|EISDIR|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT): ([^\n]+)/u, (original, prefix: string, code: string, detail: string) => {
		const copy = errorCodeCopy(locale, code);
		if (copy === undefined) return original;
		const path = detail.indexOf("'");
		return `${prefix}${copy}: ${path < 0 ? detail : detail.slice(path)}`;
	});
}

/** Harness remarks are structured separately from the tool's own stdout and returned data. */
export function toolDiagnosticCopy(locale: Locale, code: string | undefined, message: string): string {
	let match = /^Full output: ([\s\S]+)$/u.exec(message);
	if (code === "full_output" && match) return translate(locale, "tool.fullOutput", { path: match[1]! });
	match = /^Command exited with code (-?\d+)$/u.exec(message);
	if (code === "exit_code" && match) return translate(locale, "tool.commandFailed", { code: match[1]! });
	match = /^Output truncated(?: to its (?:beginning|end))?: (\d+) lines, (\d+) bytes dropped$/u.exec(message);
	if (code === "truncated" && match) return translate(locale, "tool.outputTruncated", { lines: match[1]!, bytes: match[2]! });
	match = /^Showing lines (\d+)-(\d+) of (\d+)(?: \((.+) limit\))?\. Use offset=(\d+) to continue\.$/u.exec(message);
	if (code === "truncated" && match) return translate(locale, "tool.readSlice", { first: match[1]!, last: match[2]!, total: match[3]!, limit: match[4] === undefined ? "" : ` · ${match[4]}`, next: match[5]! });
	match = /^(\d+) more lines in file\. Use offset=(\d+) to continue\.$/u.exec(message);
	if (code === undefined && match) return translate(locale, "tool.readMore", { count: match[1]!, next: match[2]! });
	match = /^(.+) changed during reading\. Read a stable version before editing or replacing it\.$/u.exec(message);
	if (code === "file_changed" && match) return translate(locale, "tool.fileChanged", { path: match[1]! });
	const human = errorMessageCopy(locale, message);
	if (human !== message) return human;
	const copy = code === undefined ? undefined : errorCodeCopy(locale, code);
	if (copy === undefined) return message;
	if (code === "blocked" && message.startsWith("Tool call blocked: ")) return `${copy}: ${errorMessageCopy(locale, message.slice("Tool call blocked: ".length))}`;
	// These fixed harness notices add no operation detail beyond the card's tool name and arguments.
	if ((code === "tool_unavailable" && /^Tool .+ is not available$/u.test(message))
		|| (code === "aborted" && /^Tool .+ was aborted$/u.test(message))
		|| (code === "abandoned" && /^Tool .+ was not started: its caller ended with a restart$/u.test(message))
		|| (code === "interrupted" && /^Tool .+ was interrupted(?: by a restart)? and may have partially run$/u.test(message))) return copy;
	return `${copy}: ${message}`;
}
