import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@amazme/chord";

/** Path-based sandboxes cannot distinguish an existing writable inode from its aliases outside the workspace. */
export async function assertUnsharedWorkspaces(roots: readonly string[], context: Context): Promise<void> {
	const pending = [...roots];
	const visited = new Set<string>();
	while (pending.length) {
		context.abortSignal?.throwIfAborted();
		const path = pending.pop()!;
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) continue;
		if (metadata.isFile() && metadata.nlink > 1) {
			throw new Error(`工作区包含硬链接，无法保证目录外文件不被改写：${path}。请先将硬链接替换为独立文件。`);
		}
		if (!metadata.isDirectory()) continue;
		const identity = `${metadata.dev}:${metadata.ino}`;
		if (visited.has(identity)) continue;
		visited.add(identity);
		for (const entry of await readdir(path)) pending.push(join(path, entry));
	}
}

/** Native writes also refuse shared inodes; reading and unlinking a link do not grant content-write authority. */
export async function assertUnsharedFile(path: string): Promise<void> {
	try {
		const metadata = await lstat(path);
		if (metadata.isFile() && metadata.nlink > 1) throw new Error(`硬链接不允许写入：${path}。请先将它替换为独立文件。`);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}
