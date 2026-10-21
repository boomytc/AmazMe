import { remoteService } from "@amazme/protocol/services";
import { type Context } from "@amazme/chord";

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
	/** null remembers the standalone group rather than falling back to a project. */
	projectId?: string | null;
	sessionId?: string;
	/**
	 * Older pages stored the archive browser here. New pages omit it. Readers ignore the value
	 * and decide from the session's own archive stamp.
	 */
	showArchived?: boolean;
	/** The archive state when selected, so an offline archive does not reopen an active session. */
	archivedAt?: number;
}

export function isProjectSelection(value: unknown): value is ProjectSelection {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (row.showArchived === undefined || typeof row.showArchived === "boolean")
		&& (row.projectId === undefined || row.projectId === null || typeof row.projectId === "string")
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
	/** Archive and stop all project sessions, preserving their history and working directory. */
	remove(projectId: string, context: Context): Promise<void>;
}

export interface ProjectFolders {
	path: string;
	parent: string | null;
	entries: { name: string; path: string }[];
}

export const ProjectManagement = remoteService<ProjectManagement>("amazme.project-management", {"selection":0,"remember":1,"create":1,"update":2,"folders":1,"rename":2,"remove":1}, []);

export interface SessionArchive {
	/** Archiving stops all work, discards queues, and rejects future inputs until restored. */
	set(sessionId: string, archived: boolean, context: Context): Promise<void>;
}

export const SessionArchive = remoteService<SessionArchive>("amazme.session-archive", {"set":2}, []);
