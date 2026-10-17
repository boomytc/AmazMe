import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Longest published name: server-<uuidv4>-<12 hex nonce>.sock.
const LONGEST_SOCKET_NAME = `server-${"0".repeat(8)}-${"0".repeat(4)}-4000-8000-${"0".repeat(12)}-${"0".repeat(12)}.sock`;

/**
 * libuv copies `sizeof(sun_path)` bytes and truncates the rest, and `listen` still
 * succeeds. The filesystem entry is then a different name, so discovery never sees
 * `${serverId}.sock`. Linux sun_path is 108 and a 108-byte path binds exactly; 109
 * does not. macOS and the BSDs use 104 including the terminating NUL.
 */
export function maxUnixSocketPathBytes(): number {
	return process.platform === "linux" ? 108 : 103;
}

export function unixSocketPathFits(directory: string): boolean {
	return Buffer.byteLength(join(directory, LONGEST_SOCKET_NAME)) <= maxUnixSocketPathBytes();
}

/** Refuse a path libuv would silently truncate to a different socket name. */
export function assertConnectableUnixSocketPath(path: string): void {
	if (process.platform === "win32") return;
	const max = maxUnixSocketPathBytes();
	const bytes = Buffer.byteLength(path);
	if (bytes <= max) return;
	throw new Error(
		`Unix socket path is ${bytes} bytes; the platform accepts ${max}, and a longer listen is truncated to a different name: ${path}`,
	);
}

/**
 * Directory whose socket names are connectable. The longest name is
 * `server-<id>-<nonce>.sock`. When that path does not fit in sun_path (a deep macOS
 * TMPDIR, or any directory past the platform limit), every socket for that logical
 * directory is published under a private `/tmp` directory instead. Discovery and bind
 * must both use this path. Profile and lock files stay in the logical directory.
 */
export function hostSocketDirectory(logicalDirectory: string): string {
	if (process.platform === "win32" || unixSocketPathFits(logicalDirectory)) return logicalDirectory;
	const uid = process.getuid?.() ?? 0;
	const hash = createHash("sha256").update(logicalDirectory).digest("hex").slice(0, 12);
	return join("/tmp", `am-${uid}`, hash);
}

export async function ensureHostSocketDirectory(logicalDirectory: string): Promise<string> {
	const directory = hostSocketDirectory(logicalDirectory);
	if (directory === logicalDirectory) return directory;
	const uid = process.getuid?.() ?? 0;
	await ensurePrivateDirectory(join("/tmp", `am-${uid}`));
	await ensurePrivateDirectory(directory);
	if (!unixSocketPathFits(directory)) {
		throw new Error(`Relocated Unix socket directory still exceeds sun_path: ${directory}`);
	}
	return directory;
}

/**
 * Drop a relocated socket directory after its sockets are gone. Only an empty
 * `/tmp/am-<uid>/<hash>` is removed. The parent `/tmp/am-<uid>` stays, a directory
 * that still has entries stays, and a busy removal is ignored.
 */
export async function removeEmptyRelocatedSocketDirectory(directory: string): Promise<void> {
	const uid = process.getuid?.();
	if (uid === undefined) return;
	const parent = join("/tmp", `am-${uid}`);
	if (dirname(directory) !== parent) return;
	if (!/^[0-9a-f]{12}$/.test(basename(directory))) return;
	try {
		await rmdir(directory);
	} catch {
		// Non-empty, already gone, or held by a concurrent process.
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("Unix socket directory requires a POSIX user ID");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stats = await lstat(directory);
	if (!stats.isDirectory()) throw new Error(`Unix socket directory is not a directory: ${directory}`);
	if (stats.uid !== uid) throw new Error(`Unix socket directory is not owned by the current user: ${directory}`);
	await chmod(directory, 0o700);
}
