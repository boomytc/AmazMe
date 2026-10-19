/**
 * Output files: files pi writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output and binary MCP resources. Every output file is created here,
 * under the session's artifact directory (`ExecutionEnv.artifactDirectory`, see
 * `SessionLocation.artifactDirectory`), so the files are deleted with the session. The directory is a
 * required argument: there is no OS temp-directory fallback.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;
/** The artifact directory may be created here first (an ephemeral session creates it lazily). */
const OUTPUT_DIRECTORY_MODE = 0o700;

/** A new, unused path: `<directory>/<prefix>-<random hex><extension>`. `extension` includes the dot. */
function createOutputFilePath(directory: string, prefix: string, extension: string): string {
	return join(directory, `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Write `data` to a new output file under the session's `artifactDirectory` and return its path. */
export async function writeOutputFile(
	artifactDirectory: string,
	prefix: string,
	extension: string,
	data: string | Uint8Array,
): Promise<string> {
	await mkdir(artifactDirectory, { recursive: true, mode: OUTPUT_DIRECTORY_MODE });
	const path = createOutputFilePath(artifactDirectory, prefix, extension);
	// `wx` never follows a link someone else placed at the path.
	await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
	return path;
}

/** Open a new output file for streamed output under the session's `artifactDirectory`. */
export function createOutputFileStream(
	artifactDirectory: string,
	prefix: string,
	extension: string,
): { path: string; stream: WriteStream } {
	mkdirSync(artifactDirectory, { recursive: true, mode: OUTPUT_DIRECTORY_MODE });
	const path = createOutputFilePath(artifactDirectory, prefix, extension);
	return { path, stream: createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" }) };
}
