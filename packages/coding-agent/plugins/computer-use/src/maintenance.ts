import { execFile } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "./installation.ts";

const execute = promisify(execFile);
export const buildCacheRoot = () =>
	join(homedir(), "Library/Caches/AmazMe/ComputerUse/build");

export async function createBuildWorkspace(
	root: string,
	version: string,
): Promise<string> {
	await mkdir(root, { recursive: true });
	const directory = await mkdtemp(join(root, ".build-"));
	await writeFile(
		join(directory, "owner.json"),
		JSON.stringify({
			kind: "amazme-computer-use-build",
			pid: process.pid,
			version,
		}),
	);
	return directory;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ESRCH"
		)
			return false;
		return true;
	}
}

/** lsof checks executable mappings, current directories and open files, including descendants. */
export async function directoryInUse(directory: string): Promise<boolean> {
	try {
		const { stdout } = await execute(
			"/usr/sbin/lsof",
			["-n", "-P", "-t", "+D", directory],
			{ timeout: 30_000 },
		);
		return stdout.trim().length > 0;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === 1 &&
			"stdout" in error &&
			"stderr" in error
		) {
			if (typeof error.stderr === "string" && error.stderr.trim() === "")
				return (
					typeof error.stdout !== "string" || error.stdout.trim().length > 0
				);
		}
		throw error;
	}
}

type CleanupResult = {
	path: string;
	status: "current" | "unrecognized" | "busy" | "candidate" | "removed";
};

async function cleanDirectories(
	root: string,
	eligible: (
		path: string,
		name: string,
	) => Promise<"current" | "unrecognized" | "busy" | "candidate">,
	apply: boolean,
): Promise<CleanupResult[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		},
	);
	const results: CleanupResult[] = [];
	// Never follow a substituted cache root into another application's files.
	if (entries.length && (await realpath(root)) !== root)
		throw new Error(`Cleanup root must be a canonical directory: ${root}`);
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const path = join(root, entry.name);
		const before = await lstat(path);
		let status = await eligible(path, entry.name);
		if (status === "candidate" && (await directoryInUse(path))) status = "busy";
		if (status === "candidate" && apply) {
			const now = await lstat(path);
			if (
				before.ino !== now.ino ||
				before.dev !== now.dev ||
				now.isSymbolicLink()
			)
				throw new Error(`Cleanup directory changed: ${path}`);
			await rm(path, { recursive: true });
			results.push({ path, status: "removed" });
		} else results.push({ path, status });
	}
	return results;
}

export async function cleanupBuildWorkspaces(root: string, apply = false) {
	return cleanDirectories(
		root,
		async (path, name) => {
			if (!/^\.build-[A-Za-z0-9]+$/u.test(name)) return "unrecognized";
			const owner: unknown = await readFile(join(path, "owner.json"), "utf8")
				.then(JSON.parse)
				.catch(() => undefined);
			if (
				typeof owner !== "object" ||
				owner === null ||
				!("kind" in owner) ||
				owner.kind !== "amazme-computer-use-build" ||
				!("pid" in owner) ||
				typeof owner.pid !== "number" ||
				!Number.isSafeInteger(owner.pid) ||
				owner.pid <= 0
			)
				return "unrecognized";
			return alive(owner.pid) ? "busy" : "candidate";
		},
		apply,
	);
}

export async function cleanupPermissionPanels(
	root: string,
	currentKey: string,
	apply = false,
) {
	return cleanDirectories(
		root,
		async (path, name) => {
			if (name === currentKey) return "current";
			if (!/^[a-f0-9]{64}$/u.test(name)) return "unrecognized";
			try {
				const manifest: unknown = JSON.parse(
					await readFile(join(path, "manifest.json"), "utf8"),
				);
				const binary = await readFile(
					join(
						path,
						"AmazMe Permissions.app/Contents/MacOS/amazme-permissions",
					),
				);
				if (
					typeof manifest !== "object" ||
					manifest === null ||
					!("source" in manifest) ||
					manifest.source !== name ||
					!("binary" in manifest) ||
					manifest.binary !== sha256(binary)
				)
					return "unrecognized";
				return "candidate";
			} catch {
				return "unrecognized";
			}
		},
		apply,
	);
}
