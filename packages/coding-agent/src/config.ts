/** Package identity and terminal asset paths; Python owns business configuration. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const isBunBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");

export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			// build:binary places Bun's metadata inside dist/. Node still needs the
			// package root so its dist-relative asset paths do not become dist/dist/.
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				return parent;
			}
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.AMAZME_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	return findNodePackageDir(__dirname);
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For source (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}
interface PackageJson {
	name?: string;
	version?: string;
	bin?: string | Record<string, string>;
	amazmeConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
try {
	const packageJsonPath = getPackageJsonPath();
	pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const amazmeConfigName: string | undefined = pkg.amazmeConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@amazme/coding-agent";
export const APP_NAME: string = amazmeConfigName || "AmazMe";
export const APP_COMMAND: string = typeof pkg.bin === "object" ? (Object.keys(pkg.bin)[0] ?? "amazme") : "amazme";
export const APP_TITLE: string = amazmeConfigName ? APP_NAME : "AmazMe";
export const CONFIG_DIR_NAME: string = pkg.amazmeConfig?.configDir || ".amazme";
export const VERSION: string = pkg.version || "0.0.0";

// e.g., AMAZME_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;

export function expandTildePath(path: string): string {
	return normalizePath(path);
}
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}
