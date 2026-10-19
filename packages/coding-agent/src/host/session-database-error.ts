/**
 * How a Session database that cannot be opened reaches a client. The server reports it as a Chord `unavailable` error
 * whose reason names the kind (`session_database_newer_schema`, ...), and whose message is the readable text: the path,
 * the reason, and what to do. This module has no Node dependencies, so the web page can use it.
 */
export const SESSION_DATABASE_ERROR_REASON_PREFIX = "session_database_";

/** The Chord reason for a `SessionOpenError` kind: `newer-schema` becomes `session_database_newer_schema`. */
export function sessionDatabaseErrorReason(kind: string): string {
	return `${SESSION_DATABASE_ERROR_REASON_PREFIX}${kind.replaceAll("-", "_")}`;
}

/**
 * The readable text of a Session database error received from the server, without the Chord `code/reason: ` prefix;
 * `undefined` for any other error.
 */
export function sessionDatabaseErrorText(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("reason" in error)) return undefined;
	const { reason } = error;
	if (typeof reason !== "string" || !reason.startsWith(SESSION_DATABASE_ERROR_REASON_PREFIX)) return undefined;
	const prefix = /^[a-z_]+\/[a-z_]+: /u.exec(error.message);
	return prefix === null ? error.message : error.message.slice(prefix[0].length);
}
