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
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { installationRoot, readInstallation, sha256 } from "./installation.ts";
import { PATCH_PIN } from "./runtime-pin.ts";

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
	status:
		| "current"
		| "newer"
		| "unrecognized"
		| "busy"
		| "candidate"
		| "removed";
};

async function cleanDirectories(
	root: string,
	eligible: (
		path: string,
		name: string,
	) => Promise<Exclude<CleanupResult["status"], "removed">>,
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
			// Ownership and build liveness may have changed while lsof was running.
			status = await eligible(path, entry.name);
			if (status !== "candidate") {
				results.push({ path, status });
				continue;
			}
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

const releaseMarker = ".computer-use-version.json";
const releaseKind = "amazme-computer-use-release";

async function readRecord(
	path: string,
): Promise<Record<string, unknown> | undefined> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function versionParts(version: string): bigint[] | undefined {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-amazme\.(0|[1-9]\d*))?$/u.exec(
			version,
		);
	return match ? match.slice(1).map((part) => BigInt(part ?? 0)) : undefined;
}

function versionStatus(
	version: string,
): "current" | "newer" | "unrecognized" | "candidate" {
	if (version === PATCH_PIN.version) return "current";
	const parts = versionParts(version);
	const current = versionParts(PATCH_PIN.version)!;
	if (!parts) return "unrecognized";
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] < current[i]) return "candidate";
		if (parts[i] > current[i]) return "newer";
	}
	return "unrecognized";
}

/** The repository build entrypoint marks the version directory it owns. */
export async function markReleaseDirectory(
	root: string,
	version: string,
): Promise<void> {
	if (!versionParts(version))
		throw new Error(`Invalid runtime version: ${version}`);
	await mkdir(root, { recursive: true });
	if ((await realpath(root)) !== root)
		throw new Error(`Release directory must be canonical: ${root}`);
	const marker = join(root, releaseMarker);
	const expected = { kind: releaseKind, version };
	try {
		await writeFile(marker, JSON.stringify(expected), { flag: "wx" });
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "EEXIST"
		)
			throw error;
		const actual = await readRecord(marker);
		if (actual?.kind !== expected.kind || actual?.version !== version)
			throw new Error(`Unrecognized release owner: ${root}`);
	}
}

/** A verified default is the deletion barrier; staging a candidate cannot prune it. */
export async function cleanupRuntimeVersions({
	root = installationRoot(),
	releaseRoot,
	apply = false,
}: {
	root?: string;
	releaseRoot?: string;
	apply?: boolean;
} = {}) {
	if (process.platform !== "darwin")
		throw new Error("Runtime version cleanup currently supports macOS");
	const current = await readInstallation(join(root, PATCH_PIN.version), {
		...PATCH_PIN,
		platform: "darwin",
		arch: process.arch,
	});
	if (!current) return { runtimes: [], releases: [] };
	const runtimes = await cleanDirectories(
		root,
		async (path, name) => {
			const status = versionStatus(name);
			if (status !== "candidate") return status;
			try {
				const manifest = await readRecord(join(path, "manifest.json"));
				if (
					manifest?.version !== name ||
					manifest.platform !== "darwin" ||
					typeof manifest.arch !== "string" ||
					!["arm64", "x64"].includes(manifest.arch)
				)
					return "unrecognized";
				const source =
					typeof manifest.sourceCommit === "string" &&
					/^[a-f0-9]{40}$/u.test(manifest.sourceCommit) &&
					typeof manifest.patchSha256 === "string" &&
					/^[a-f0-9]{64}$/u.test(manifest.patchSha256);
				const archive =
					typeof manifest.archiveSha256 === "string" &&
					/^[a-f0-9]{64}$/u.test(manifest.archiveSha256);
				if (!source && !archive) return "unrecognized";
				await readInstallation(path, {
					version: name,
					platform: "darwin",
					arch: manifest.arch,
				});
				return "candidate";
			} catch {
				return "unrecognized";
			}
		},
		apply,
	);
	const releases = releaseRoot
		? await cleanDirectories(
				releaseRoot,
				async (path, name) => {
					const status = versionStatus(name);
					if (status !== "candidate") return status;
					try {
						const marker = await readRecord(join(path, releaseMarker));
						if (marker?.kind !== releaseKind || marker.version !== name)
							return "unrecognized";
					} catch {
						return "unrecognized";
					}
					const builds = (await cleanupBuildWorkspaces(path)).filter((entry) =>
						basename(entry.path).startsWith(".build-"),
					);
					if (builds.some((entry) => entry.status === "busy")) return "busy";
					if (builds.some((entry) => entry.status === "unrecognized"))
						return "unrecognized";
					return "candidate";
				},
				apply,
			)
		: [];
	return { runtimes, releases };
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
