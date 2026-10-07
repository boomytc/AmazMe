import { stat, readdir, readFile, open } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@amazme/chord";
import { Workspace, type WorkspaceEntry, type WorkspaceState, type WorkspaceView } from "./workspace.ts";

/** How much of one file the reader is shown; beyond it the view says the text is truncated. */
export const WORKSPACE_MAX_BYTES = 256 * 1024;
/** How much of a file is inspected for binary content. */
const SNIFF_BYTES = 8 * 1024;

export interface WorkspaceServiceOptions {
	/** The Session's working directory: the root the workspace browses and never leaves. */
	readonly cwd: string;
}

/**
 * The workspace over the Session's working directory. Paths are relative to that directory and
 * anything that would resolve outside it is refused, so a presentation cannot walk the machine's
 * filesystem through this service.
 */
export function createWorkspaceService(
	options: WorkspaceServiceOptions,
	createState: (initial: WorkspaceState) => MutableReplicatedState<WorkspaceState>,
) {
	const root = resolve(options.cwd);
	const state = createState({
		revision: 0,
		cwd: root,
		view: { kind: "listing", path: ".", parent: null, entries: [] },
	});

	/** The absolute path for a workspace-relative one, or undefined when it leaves the root. */
	const resolveInside = (path: string): string | undefined => {
		const trimmed = path.trim();
		const candidate = trimmed === "" || trimmed === "." ? root : resolve(root, trimmed);
		if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
		return candidate;
	};

	const workspaceRelative = (absolute: string): string => {
		const path = relative(root, absolute);
		return path.length === 0 ? "." : path;
	};

	const publish = (context: Context, view: WorkspaceView): void => {
		state.change(context, (draft) => {
			draft.revision += 1;
			draft.cwd = root;
			draft.view = view;
		});
	};

	const list = async (absolute: string, context: Context): Promise<void> => {
		const path = workspaceRelative(absolute);
		let names: string[];
		try {
			names = await readdir(absolute);
		} catch {
			publish(context, { kind: "missing", path });
			return;
		}
		const entries: WorkspaceEntry[] = [];
		for (const name of names) {
			try {
				const info = await stat(join(absolute, name));
				entries.push({
					name,
					kind: info.isDirectory() ? "dir" : "file",
					size: info.isDirectory() ? 0 : info.size,
				});
			} catch {
				// A name that vanished between the listing and the stat is left out rather than failing it.
			}
		}
		entries.sort((left, right) =>
			left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "dir" ? -1 : 1,
		);
		publish(context, {
			kind: "listing",
			path,
			parent: absolute === root ? null : workspaceRelative(resolve(absolute, "..")),
			entries,
		});
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

	return {
		service: {
			state,
			async open(path: string, context: Context): Promise<void> {
				const absolute = resolveInside(path);
				if (absolute === undefined) {
					publish(context, {
						kind: "denied",
						path,
						reason: "The workspace stays inside the session's working directory.",
					});
					return;
				}
				await list(absolute, context);
			},
			async read(path: string, context: Context): Promise<void> {
				const absolute = resolveInside(path);
				if (absolute === undefined) {
					publish(context, {
						kind: "denied",
						path,
						reason: "The workspace stays inside the session's working directory.",
					});
					return;
				}
				await read(absolute, context);
			},
		} satisfies Workspace,
		/** The starting view: the working directory itself, listed. */
		async refresh(context: Context): Promise<void> {
			await list(root, context);
		},
	};
}

/** The workspace as a facet: the service, and the working directory listed when it activates. */
export function createWorkspaceFacet(options: WorkspaceServiceOptions): Facet {
	return defineFacet({
		id: "@pi/workspace",
		setup(env) {
			const runtime = createWorkspaceService(options, (initial) => env.replicatedState(initial));
			env.provide(Workspace, runtime.service);
			env.onActivate(() => runtime.refresh(BACKGROUND_CONTEXT));
		},
	});
}
