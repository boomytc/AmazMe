import { type Context, defineService } from "@amazme/chord";

export interface ProjectSummary {
	id: string;
	name: string;
	cwd: string;
	/** Authorized project folders; cwd is the default execution directory. */
	workspaces?: string[];
	/** Changes whenever source folders are saved, including renewed consent for the same folders. */
	revision?: number;
	createdAt: number;
	removed?: true;
}

/** Per-window navigation, also saved by the host as a fallback for a newly opened client. */
export interface ProjectSelection {
	projectId?: string;
	sessionId?: string;
	showArchived: boolean;
	/** The archive state when selected, so an offline archive does not reopen an active session. */
	archivedAt?: number;
}

export function isProjectSelection(value: unknown): value is ProjectSelection {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row.showArchived === "boolean"
		&& (row.projectId === undefined || typeof row.projectId === "string")
		&& (row.sessionId === undefined || typeof row.sessionId === "string")
		&& (row.archivedAt === undefined || (typeof row.archivedAt === "number" && Number.isFinite(row.archivedAt)));
}

export interface ProjectManagement {
	selection(context: Context): Promise<ProjectSelection | undefined>;
	remember(selection: ProjectSelection, context: Context): Promise<void>;
	create(options: { cwd: string; name?: string; workspaces?: string[]; projectId?: string }, context: Context): Promise<ProjectSummary>;
	update(projectId: string, options: { name: string; workspaces: string[] }, context: Context): Promise<ProjectSummary>;
	/** Folder selection on the machine running the host, including for a remote Web client. */
	folders(options: { path?: string }, context: Context): Promise<ProjectFolders>;
	rename(projectId: string, name: string, context: Context): Promise<ProjectSummary>;
	/** Archive all project sessions, preserving their history and working directory. */
	remove(projectId: string, context: Context): Promise<void>;
}

export interface ProjectFolders {
	path: string;
	parent: string | null;
	entries: { name: string; path: string }[];
}

export const ProjectManagement = defineService<ProjectManagement>("amazme.project-management");

export interface SessionArchive {
	set(sessionId: string, archived: boolean, context: Context): Promise<void>;
	/** Explicitly stop all work, discard queues, and reject future inputs until restored. */
	end(sessionId: string, context: Context): Promise<void>;
}

export const SessionArchive = defineService<SessionArchive>("amazme.session-archive");
