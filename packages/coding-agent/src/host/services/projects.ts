import { type Context, defineService } from "@amazme/chord";

export interface ProjectSummary {
	id: string;
	name: string;
	cwd: string;
	createdAt: number;
	removed?: true;
}

export interface ProjectManagement {
	create(options: { cwd: string; name?: string }, context: Context): Promise<ProjectSummary>;
	rename(projectId: string, name: string, context: Context): Promise<ProjectSummary>;
	/** Archive all project sessions, preserving their history and working directory. */
	remove(projectId: string, context: Context): Promise<void>;
}

export const ProjectManagement = defineService<ProjectManagement>("amazme.project-management");

export interface SessionArchive {
	set(sessionId: string, archived: boolean, context: Context): Promise<void>;
}

export const SessionArchive = defineService<SessionArchive>("amazme.session-archive");
