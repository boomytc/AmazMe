import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { inspectPluginPackage } from "../../core/plugins/package.ts";
import { buildPluginEntry, PLUGIN_BUILD_FILE, type PluginArtifact } from "../../core/plugins/artifact.ts";
import type { ServerId } from "@amazme/protocol";

const PLUGIN_PACKAGE_PROFILE_VERSION = 1;

export interface ConfiguredServerPluginPackage {
	readonly manifestPath: string;
	build(): Promise<readonly PluginArtifact[]>;
}

/** Persist an explicit plugin package selection or restore it for a later server generation. */
export async function restoreServerPluginPackageProfile(
	directory: string,
	serverId: ServerId,
	configuredPackagePaths?: readonly string[],
): Promise<readonly string[]> {
	const path = join(directory, `plugin-packages-${serverId}.json`);
	if (configuredPackagePaths === undefined) {
		return (await readPluginPackageProfile(path, false)) ?? [];
	}
	const packagePaths = normalizePluginPackagePaths(configuredPackagePaths);
	if (packagePaths.length === 0) await rm(path, { force: true });
	else await writePluginPackageProfile(path, packagePaths);
	return packagePaths;
}

/** Read the explicit plugin selection stored for one durable Session. */
export function readSessionPluginPackageProfile(
	directory: string,
	serverId: ServerId,
	sessionPath: string,
): Promise<readonly string[] | undefined> {
	return readPluginPackageProfile(sessionPluginProfilePath(directory, serverId, sessionPath), true, sessionPath);
}

/** Remove the plugin selection stored for one deleted Session. */
export async function removeSessionPluginPackageProfile(
	directory: string,
	serverId: ServerId,
	sessionPath: string,
): Promise<void> {
	await rm(sessionPluginProfilePath(directory, serverId, sessionPath), { force: true });
}

/** Persist the plugin selection for one durable Session. */
export function writeSessionPluginPackageProfile(
	directory: string,
	serverId: ServerId,
	sessionPath: string,
	packagePaths: readonly string[],
): Promise<void> {
	return writePluginPackageProfile(
		sessionPluginProfilePath(directory, serverId, sessionPath),
		normalizePluginPackagePaths(packagePaths),
		sessionPath,
	);
}

/** Create a serialized server-owned builder for one configured plugin package. */
export function createServerPluginPackage(
	directory: string,
	serverId: ServerId,
	packagePath: string,
): ConfiguredServerPluginPackage {
	const normalizedPackagePath = resolve(packagePath);
	const outdir = join(directory, "plugin-builds", serverId, pluginBuildDirectoryName(normalizedPackagePath));
	const manifestPath = join(outdir, PLUGIN_BUILD_FILE);
	let buildTail = Promise.resolve();
	return {
		manifestPath,
		build() {
			const operation = buildTail.then(async () => {
				const pkg = await inspectPluginPackage(normalizedPackagePath);
    const entries: Record<string, PluginArtifact> = {};
    for (const [kind, path] of Object.entries(pkg.entries)) entries[kind] = await buildPluginEntry(`${pkg.name}/${kind}`, path);
    await mkdir(outdir, { recursive: true });
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ name: pkg.name, entries }), { mode: 0o600 }); await rename(temporary, manifestPath); }
    finally { await rm(temporary, { force: true }); }
    return entries.tui ? [entries.tui] : [];
			});
			buildTail = operation.then(
				() => undefined,
				() => undefined,
			);
			return operation;
		},
	};
}

async function readPluginPackageProfile(
	path: string,
	allowEmpty: boolean,
	sessionPath?: string,
): Promise<readonly string[] | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Could not read experimental plugin package profile ${path}`, { cause: error });
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.keys(parsed).some(
			(key) => key !== "version" && key !== "packagePaths" && !(key === "sessionPath" && sessionPath !== undefined),
		) ||
		!("version" in parsed) ||
		parsed.version !== PLUGIN_PACKAGE_PROFILE_VERSION ||
		(sessionPath === undefined
			? "sessionPath" in parsed
			: !("sessionPath" in parsed) || parsed.sessionPath !== sessionPath) ||
		!("packagePaths" in parsed) ||
		!Array.isArray(parsed.packagePaths) ||
		(!allowEmpty && parsed.packagePaths.length === 0) ||
		parsed.packagePaths.some((packagePath) => typeof packagePath !== "string" || packagePath.length === 0)
	) {
		throw new Error(`Invalid experimental plugin package profile ${path}`);
	}
	return normalizePluginPackagePaths(parsed.packagePaths as readonly string[]);
}

function writePluginPackageProfile(path: string, packagePaths: readonly string[], sessionPath?: string): Promise<void> {
	return writeFile(
		path,
		`${JSON.stringify(
			{
				version: PLUGIN_PACKAGE_PROFILE_VERSION,
				...(sessionPath === undefined ? {} : { sessionPath }),
				packagePaths,
			},
			null,
			2,
		)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

export function normalizePluginPackagePaths(packagePaths: readonly string[]): readonly string[] {
	const normalized = packagePaths.map((packagePath) => {
		if (packagePath.length === 0) throw new Error("Plugin package path must not be empty");
		return resolve(packagePath);
	});
	if (new Set(normalized).size !== normalized.length) {
		throw new Error("Plugin package paths must be unique");
	}
	return Object.freeze(normalized);
}

function sessionPluginProfilePath(directory: string, serverId: ServerId, sessionPath: string): string {
	const hash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 24);
	return join(directory, `session-plugin-packages-${serverId}-${hash}.json`);
}

function pluginBuildDirectoryName(packagePath: string): string {
	const packageDirectory = basename(packagePath) === "package.json" ? dirname(packagePath) : packagePath;
	const base = basename(packageDirectory).replaceAll(/[^a-zA-Z0-9._-]/gu, "-") || "plugin";
	const label = base.endsWith("-plugin") ? base : `${base}-plugin`;
	const hash = createHash("sha256").update(packagePath).digest("hex").slice(0, 12);
	return `${label}-${hash}`;
}
