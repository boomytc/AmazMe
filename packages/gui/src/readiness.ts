import { parsePythonReadyLine, type PythonReady } from "./python-backend.ts";

export interface ReadinessParser {
	/** Consume one stdout chunk. Returns the page URL once a full launch line has arrived. */
	push(chunk: string): string | undefined;
	/** Treat any trailing partial line as complete. Throws when no launch line was seen. */
	finalize(): string;
	/** Identity from the packaged Python backend's readiness JSON. */
	pythonReady(): PythonReady | undefined;
}

/** Incremental parser so a launch line split across reads is still one URL. */
export function createReadinessParser(): ReadinessParser {
	let pending = "";
	let readyUrl: string | undefined;
	let python: PythonReady | undefined;

	const acceptUrl = (parsed: string): string => {
		if (readyUrl !== undefined && parsed !== readyUrl) {
			throw new Error(`desktop host emitted conflicting launch URLs: ${readyUrl} and ${parsed}`);
		}
		readyUrl = parsed;
		return readyUrl;
	};

	const accept = (line: string): string | undefined => {
		const backend = parsePythonReadyLine(line);
		if (backend !== undefined) {
			python = backend;
			return acceptUrl(backend.pageUrl);
		}
		return undefined;
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
		pythonReady() {
			return python;
		},
	};
}
