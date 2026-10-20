/**
 * macOS code signing for the desktop bundle.
 *
 * Preview builds and releases go through the same inside-out signing. Releases sign with a
 * Developer ID from a dedicated keychain, checked against the expected team, and with the hardened
 * runtime and its entitlements, which notarization requires. Ad-hoc previews have no team, so
 * library validation under the hardened runtime would refuse their own Electron framework; they
 * sign without the runtime instead of weakening the release entitlements.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

/** @typedef {{ kind: "ad-hoc" }} AdHocSigning */
/** @typedef {{ kind: "developer-id", entitlements: string, keychain: string, identity: string, teamId: string }} DeveloperIdSigning */
/** @typedef {AdHocSigning | DeveloperIdSigning} Signing */

const THIN_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const FAT_MAGICS = new Set([0xcafebabe, 0xcafebabf]);
const BUNDLE_SUFFIXES = [".app", ".framework"];

/**
 * Runs a tool and returns stdout + stderr. Failures name the tool and carry its output, never its
 * arguments; callers handling credentials catch the error and report less.
 */
export function tool(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.error) {
		const error = new Error(`${basename(command)} ${args[0] ?? ""} could not start: ${result.error.message}`);
		error.toolErrorCode = result.error.code;
		throw error;
	}
	const output = `${result.stdout}${result.stderr}`;
	if (result.status !== 0) {
		const error = new Error(`${basename(command)} ${args[0] ?? ""} exited with ${result.status}\n${output.trim()}`);
		error.output = output;
		error.exitCode = result.status;
		error.signal = result.signal;
		throw error;
	}
	return output;
}

/** Java class files share the fat magic; their "architecture count" is a class-file version (>= 45). */
export function isMachOHeader(header) {
	if (header.length < 8) return false;
	const magic = header.readUInt32BE(0);
	if (THIN_MAGICS.has(magic)) return true;
	return FAT_MAGICS.has(magic) && header.readUInt32BE(4) < 45;
}

async function readHeader(path) {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(8);
		const { bytesRead } = await handle.read(buffer, 0, 8, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** Every nested bundle and loose Mach-O file inside the app, as paths relative to it. */
export async function collectSignableCode(appDirectory) {
	const found = [];
	const visit = async (directory) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				await visit(path);
				if (BUNDLE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) found.push(relative(appDirectory, path));
			} else if (entry.isFile() && isMachOHeader(await readHeader(path))) {
				found.push(relative(appDirectory, path));
			}
		}
	};
	await visit(appDirectory);
	return found;
}

/** Deepest code first, so each bundle seals already-signed contents; the app itself goes last. */
export function signingOrder(relativePaths) {
	const depth = (path) => path.split(sep).length;
	return [...relativePaths].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

export function codesignArguments(signing, path) {
	if (signing.kind === "ad-hoc") return ["--force", "--timestamp=none", "--sign", "-", path];
	return [
		"--force",
		"--options",
		"runtime",
		"--entitlements",
		signing.entitlements,
		"--timestamp",
		"--keychain",
		signing.keychain,
		"--sign",
		signing.identity,
		path,
	];
}

/** Picks the one Developer ID Application identity of the expected team from `security find-identity`. */
export function selectDeveloperIdIdentity(findIdentityOutput, teamId) {
	const matches = [...findIdentityOutput.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application: .*\(([A-Z0-9]+)\)"$/gm)]
		.filter((match) => match[2] === teamId)
		.map((match) => match[1]);
	const unique = [...new Set(matches)];
	if (unique.length !== 1) throw new Error(`Expected one Developer ID Application identity for team ${teamId}, found ${unique.length}`);
	return unique[0];
}

/** `TeamIdentifier` from `codesign -dv`; ad-hoc signatures report "not set". */
export function parseTeamIdentifier(codesignDisplay) {
	const value = /^TeamIdentifier=(.+)$/m.exec(codesignDisplay)?.[1]?.trim();
	return value === undefined || value === "not set" ? undefined : value;
}

export function assertTeam(path, teamId) {
	const actual = parseTeamIdentifier(tool("codesign", ["-dv", "--verbose=2", path]));
	if (actual !== teamId) throw new Error(`${basename(path)} is signed by team ${actual ?? "(none)"}, expected ${teamId}`);
}

/** Resolves --keychain/--team-id: both select a Developer ID release, neither an ad-hoc preview. */
export function resolveSigning({ keychain, teamId, entitlements }) {
	if (keychain === undefined && teamId === undefined) return { kind: "ad-hoc" };
	if (keychain === undefined || teamId === undefined || teamId.length === 0) {
		throw new Error("Developer ID signing needs both --keychain and --team-id");
	}
	const identity = selectDeveloperIdIdentity(tool("security", ["find-identity", "-v", "-p", "codesigning", keychain]), teamId);
	return { kind: "developer-id", entitlements, keychain, identity, teamId };
}

export async function signApp(appDirectory, signing) {
	for (const path of signingOrder(await collectSignableCode(appDirectory))) {
		tool("codesign", codesignArguments(signing, join(appDirectory, path)));
	}
	tool("codesign", codesignArguments(signing, appDirectory));
	tool("codesign", ["--verify", "--deep", "--strict", appDirectory]);
	if (signing.kind === "developer-id") assertTeam(appDirectory, signing.teamId);
}

export function signDiskImage(image, signing) {
	if (signing.kind === "ad-hoc") return;
	tool("codesign", ["--force", "--timestamp", "--keychain", signing.keychain, "--sign", signing.identity, image]);
	assertTeam(image, signing.teamId);
}

export async function writeChecksum(image) {
	const digest = createHash("sha256").update(await readFile(image)).digest("hex");
	await writeFile(`${image}.sha256`, `${digest}  ${basename(image)}\n`);
	return digest;
}

