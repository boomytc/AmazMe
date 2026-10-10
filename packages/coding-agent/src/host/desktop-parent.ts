import type { Readable } from "node:stream";

export const DESKTOP_PARENT_PIPE_ENV = "AMAZME_DESKTOP_PARENT_PIPE";

/**
 * Only the desktop-owned web process reads this pipe. EOF survives a parent's SIGKILL and
 * initiates ordinary host shutdown; detached/shared workers retain their existing lifecycle.
 */
export function watchDesktopParent(
	onClosed: () => void,
	input: Readable = process.stdin,
	env: NodeJS.ProcessEnv = process.env,
): () => void {
	const owned = env[DESKTOP_PARENT_PIPE_ENV] === "1";
	delete env[DESKTOP_PARENT_PIPE_ENV];
	if (!owned) return () => {};
	let closed = false;
	let disposed = false;
	const finish = (): void => {
		if (disposed || closed) return;
		closed = true;
		onClosed();
	};
	input.once("end", finish);
	input.once("close", finish);
	input.resume();
	if (input.readableEnded || input.destroyed) finish();
	return () => {
		disposed = true;
		input.off("end", finish);
		input.off("close", finish);
		input.pause();
		if ("unref" in input && typeof input.unref === "function") input.unref();
	};
}
