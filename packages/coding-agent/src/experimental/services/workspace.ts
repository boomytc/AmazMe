import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/** One entry of a directory listing. */
export interface WorkspaceEntry {
	name: string;
	kind: "dir" | "file";
	/** Bytes for a file; 0 for a directory. */
	size: number;
}

/**
 * What the workspace is showing: a listing, the text of one file, or why neither could be produced.
 * The workspace never leaves the Session's working directory, so a path above it is `denied` rather
 * than resolved.
 */
export type WorkspaceView =
	| {
			readonly kind: "listing";
			/** The directory being listed, relative to the working directory (`.` for it). */
			readonly path: string;
			/** The directory one level up, or null at the working directory itself. */
			readonly parent: string | null;
			readonly entries: WorkspaceEntry[];
	  }
	| { readonly kind: "text"; readonly path: string; readonly text: string; readonly truncated: boolean }
	| { readonly kind: "binary"; readonly path: string }
	| { readonly kind: "missing"; readonly path: string }
	| { readonly kind: "denied"; readonly path: string; readonly reason: string };

export interface WorkspaceState {
	revision: number;
	/** The Session's working directory: the root the workspace browses. */
	cwd: string;
	view: WorkspaceView;
}

/** The attached Session's working directory, as a browsable tree and a text reader. */
export interface Workspace {
	readonly state: ReplicatedState<WorkspaceState>;
	/** List a directory; `""` and `"."` mean the working directory. */
	open(path: string, context: Context): Promise<void>;
	/** Read one file as text, or report why it cannot be shown. */
	read(path: string, context: Context): Promise<void>;
}

export const Workspace = defineService<Workspace>("amazme.workspace");
