import { serviceFacet, type ServiceValue } from "@amazme/protocol/services";
import { replicatedState } from "@amazme/chord";
import type { Dirent } from "node:fs";
import { stat, readdir, readFile, open, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { type Context, type Facet, type MutableReplicatedState } from "@amazme/chord";
import { Workspace } from "./workspace.ts";
import type { WorkspaceEntry, WorkspaceOpenInput, WorkspaceState, WorkspaceView } from "./workspace.ts";

/** How much of one file the reader is shown; beyond it the view says the text is truncated. */
export const WORKSPACE_MAX_BYTES = 256 * 1024;
/** How much of a file is inspected for binary content. */
const SNIFF_BYTES = 8 * 1024;
/** Bound replicated rows and per-page metadata reads, not the directory-name enumeration itself. */
export const WORKSPACE_PAGE_SIZE = 100;

export interface WorkspaceServiceOptions {
	/** The session's execution directory, initially selected in the file browser. */
	readonly cwd: string;
	readonly directories?: () => Promise<readonly string[]>;
}

/**
 * Paths are relative to the selected project folder. Absolute paths can switch folders; resolved
 * paths and symlinks must remain inside one of the project's folders.
 */
export function createWorkspaceService(
	options: WorkspaceServiceOptions,
	createState: (initial: WorkspaceState) => MutableReplicatedState<WorkspaceState>,
) {
	let root = resolve(options.cwd);
	let roots = [root];
	let tail = Promise.resolve();
	let listed: { absolute: string; offset: number } | undefined;
	const state = createState({
		revision: 0,
		cwd: root,
		view: { kind: "listing", path: ".", parent: null, entries: [], page: { offset: 0, limit: WORKSPACE_PAGE_SIZE, total: 0 } } });

	/** Resolve a browser path and select its authorized root. */
	const inside = (path: string, directory: string): boolean => path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);
	const resolveInside = async (path: string, reopenListed = false): Promise<string | undefined> => {
		roots = await Promise.all((await options.directories?.() ?? [options.cwd]).map(directory => realpath(directory).catch(() => resolve(directory))));
		if (roots.length === 0) return undefined;
		if (!roots.includes(root)) root = roots[0]!;
		const trimmed = reopenListed && listed && inside(listed.absolute, root) ? listed.absolute : path.trim();
		const candidate = await realpath(trimmed === "" || trimmed === "." ? root : resolve(root, trimmed)).catch(() => resolve(root, trimmed));
		const selected = roots.filter(directory => inside(candidate, directory)).sort((a, b) => b.length - a.length)[0];
		if (selected === undefined) return undefined;
		root = selected;
		return candidate;
	};

	const workspaceRelative = (absolute: string): string => {
		const path = relative(root, absolute);
		return path.length === 0 ? "." : path;
	};

	const publish = (context: Context, view: WorkspaceView): void => {
		context.abortSignal?.throwIfAborted();
		state.change(context, (draft) => {
			draft.revision += 1;
			draft.cwd = root;
			draft.workspaces = [...roots];
			draft.view = view;
		});
	};

	const list = async (absolute: string, context: Context, requestedOffset?: number): Promise<void> => {
		const path = workspaceRelative(absolute);
		let names: Dirent[];
		try {
			names = await readdir(absolute, { withFileTypes: true });
		} catch {
			publish(context, { kind: "missing", path });
			return;
		}
		names.sort((left, right) => left.isDirectory() === right.isDirectory() ? left.name.localeCompare(right.name) : left.isDirectory() ? -1 : 1);
		const requested = requestedOffset ?? (listed?.absolute === absolute ? listed.offset : 0);
		const last = Math.max(0, Math.ceil(names.length / WORKSPACE_PAGE_SIZE) - 1) * WORKSPACE_PAGE_SIZE;
		const offset = Math.min(Math.floor(requested / WORKSPACE_PAGE_SIZE) * WORKSPACE_PAGE_SIZE, last);
		const entries: WorkspaceEntry[] = [];
		for (const item of names.slice(offset, offset + WORKSPACE_PAGE_SIZE)) {
			context.abortSignal?.throwIfAborted();
			const name = item.name;
			try {
				let file = join(absolute, name);
				if (item.isSymbolicLink()) {
					const target = await realpath(file);
					if (!roots.some(directory => inside(target, directory))) {
						// Keep the local name, but do not read metadata outside the authorized folders.
						entries.push({ name, kind: "file", size: 0 });
						continue;
					}
					file = target;
				}
				const info = await stat(file);
				entries.push({ name, kind: info.isDirectory() ? "dir" : "file", size: info.isDirectory() ? 0 : info.size });
			} catch {
				// A name that vanished between the listing and the stat is left out rather than failing it.
			}
		}
		entries.sort((left, right) =>
			left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "dir" ? -1 : 1,
		);
		context.abortSignal?.throwIfAborted();
		publish(context, {
			kind: "listing",
			path,
			parent: absolute === root ? null : workspaceRelative(resolve(absolute, "..")),
			entries,
			page: { offset, limit: WORKSPACE_PAGE_SIZE, total: names.length } });
		listed = { absolute, offset };
	};

	const read = async (absolute: string, context: Context): Promise<void> => {
		const path = workspaceRelative(absolute);
		let size: number;
		try {
			const info = await stat(absolute);
			if (info.isDirectory()) {
				await list(absolute, context);
				return;
			}
			size = info.size;
		} catch {
			publish(context, { kind: "missing", path });
			return;
		}
		const truncated = size > WORKSPACE_MAX_BYTES;
		let bytes: Buffer;
		try {
			if (truncated) {
				const handle = await open(absolute, "r");
				try {
					const buffer = Buffer.alloc(WORKSPACE_MAX_BYTES);
					const read = await handle.read(buffer, 0, WORKSPACE_MAX_BYTES, 0);
					bytes = buffer.subarray(0, read.bytesRead);
				} finally {
					await handle.close();
				}
			} else {
				bytes = await readFile(absolute);
			}
		} catch {
			publish(context, { kind: "missing", path });
			return;
		}
		// A NUL byte in the head of the file means this reader cannot show it as text.
		if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
			publish(context, { kind: "binary", path });
			return;
		}
		publish(context, { kind: "text", path, text: bytes.toString("utf8"), truncated });
	};

	const visit = (path: string, context: Context, operation: typeof list, reopenListed = false): Promise<void> => {
		const result = tail.catch(() => {}).then(async () => {
			const before = root;
			try {
				context.abortSignal?.throwIfAborted();
				const absolute = await resolveInside(path, reopenListed);
				context.abortSignal?.throwIfAborted();
				if (absolute === undefined) { publish(context, { kind: "denied", path, reason: "Folder is outside project workspaces." }); return; }
				await operation(absolute, context);
			} catch (error) {
				root = before;
				throw error;
			}
		});
		tail = result;
		return result;
	};
	return { service: { state,
		open: (input: WorkspaceOpenInput, context: Context) => {
			if (typeof input === "string") return visit(input, context, list);
			if (input === null || typeof input !== "object") return Promise.reject(new TypeError("Invalid workspace directory page"));
			const { path, offset } = input;
			if (typeof path !== "string" || !Number.isSafeInteger(offset) || offset < 0) return Promise.reject(new TypeError("Invalid workspace directory page"));
			return visit(path, context, (absolute, context) => list(absolute, context, offset));
		},
		read: (path: string, context: Context) => visit(path, context, read) } satisfies Workspace, refresh: (context: Context) => visit(".", context, list, true) };
}

/** The workspace as a facet: the service, and the working directory listed when it activates. */
export function createWorkspaceFacet(options: WorkspaceServiceOptions): Facet {
	return serviceFacet("@pi/workspace", Workspace, [], async (services) => {
		const runtime = createWorkspaceService(options, (initial) => replicatedState(initial));
		const implementation: ServiceValue<typeof Workspace> = runtime.service;
		await (() => runtime.refresh(BACKGROUND_CONTEXT))();

		return { value: implementation };
	});
}
