import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/** One entry of a directory listing. */
export interface WorkspaceEntry {
	name: string;
	kind: "dir" | "file";
	/** Bytes for a file; 0 for a directory. */
	size: number;
}

/** Request a bounded directory page; a plain path preserves the current page when reopening the same directory. */
export type WorkspaceOpenInput = string | { readonly path: string; readonly offset: number };

export interface WorkspacePage {
	readonly offset: number;
	readonly limit: number;
	/** Enumerated names, including entries that may vanish before their metadata is read. */
	readonly total: number;
}

/**
 * What the workspace is showing: a listing, the text of one file, or why neither could be produced.
 * Paths outside the project folders are denied; paths are relative to the browser's selected folder.
 */
export type WorkspaceView =
	| {
			readonly kind: "listing";
			/** The directory being listed, relative to the working directory (`.` for it). */
			readonly path: string;
			/** The directory one level up, or null at the working directory itself. */
			readonly parent: string | null;
			readonly entries: WorkspaceEntry[];
			/** Absent in older hosts; only this page is replicated. */
			readonly page?: WorkspacePage;
	  }
	| { readonly kind: "text"; readonly path: string; readonly text: string; readonly truncated: boolean }
	| { readonly kind: "binary"; readonly path: string }
	| { readonly kind: "missing"; readonly path: string }
	| { readonly kind: "denied"; readonly path: string; readonly reason: string };

export interface WorkspaceState {
	revision: number;
	/** The browser's currently selected project folder. */
	cwd: string;
	/** Project folders available to the file browser. cwd is its currently selected folder. */
	workspaces?: string[];
	view: WorkspaceView;
}

/** The attached session's project folders, as a browsable tree and a text reader. */
export interface Workspace {
	readonly state: ReplicatedState<WorkspaceState>;
	/** List a directory; `""` and `"."` mean the working directory. */
	open(path: WorkspaceOpenInput, context: Context): Promise<void>;
	/** Read one file as text, or report why it cannot be shown. */
	read(path: string, context: Context): Promise<void>;
}

export const Workspace = defineService<Workspace>("amazme.workspace");
