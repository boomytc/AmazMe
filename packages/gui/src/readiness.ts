/**
 * The desktop shell's view of the web host's launch line.
 *
 * `webLaunchLines` prints `Web: <url>` once `startWebHost` has bound the page. That line is the
 * same contract `dsh web:` is for the harness desktop shell: the window loads it, and nothing else.
 */

/** Prefix of the canonical launch line. `WebSocket:` does not match. */
export const WEB_READY_PREFIX = "Web: ";

export interface ReadinessParser {
	/** Consume one stdout chunk. Returns the page URL once a full launch line has arrived. */
	push(chunk: string): string | undefined;
	/** Treat any trailing partial line as complete. Throws when no launch line was seen. */
	finalize(): string;
}

/** The page URL from one launch line, or undefined when the line is not that launch line. */
export function extractWebUrl(line: string): string | undefined {
	const trimmed = line.replace(/\r$/u, "");
	if (!trimmed.startsWith(WEB_READY_PREFIX)) return undefined;
	const token = trimmed.slice(WEB_READY_PREFIX.length).split(/\s/u, 1)[0];
	if (token === undefined || token.length === 0) {
		throw new Error(`desktop host launch line has no URL: ${trimmed}`);
	}
	let url: URL;
	try {
		url = new URL(token);
	} catch {
		throw new Error(`desktop host launch URL is invalid: ${token}`);
	}
	const port = Number(url.port);
	// The host's own page is `http://127.0.0.1:<port>/`. Anything else is not that host.
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535
	) {
		throw new Error(`desktop host launch URL must be loopback HTTP with an explicit port: ${token}`);
	}
	return url.href;
}

/** Incremental parser so a launch line split across reads is still one URL. */
export function createReadinessParser(): ReadinessParser {
	let pending = "";
	let readyUrl: string | undefined;

	const accept = (line: string): string | undefined => {
		const parsed = extractWebUrl(line);
		if (parsed === undefined) return undefined;
		if (readyUrl !== undefined && parsed !== readyUrl) {
			throw new Error(`desktop host emitted conflicting launch URLs: ${readyUrl} and ${parsed}`);
		}
		readyUrl = parsed;
		return readyUrl;
	};

	return {
		push(chunk) {
			pending += chunk;
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline === -1) return readyUrl;
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				const parsed = accept(line);
				if (parsed !== undefined) return parsed;
			}
		},
		finalize() {
			if (pending !== "") accept(pending);
			if (readyUrl === undefined) {
				throw new Error("desktop host exited before emitting its launch URL");
			}
			return readyUrl;
		},
	};
}
