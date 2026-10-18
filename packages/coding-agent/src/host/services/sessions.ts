import { remoteService } from "@amazme/protocol/services";
import { type Context, type ReplicatedState } from "@amazme/chord";
import type { ServerId } from "@amazme/protocol";
import type { ProjectSummary } from "./projects.ts";

export interface SessionAddress {
	serverId: ServerId;
	sessionId: string;
}

/** Where a listed session lives. New rows are host-owned Durable sessions. */
export type SessionSource = "host" | "local";

export interface SessionSummary extends SessionAddress {
	createdAt: number;
	/** The working directory the Session's agent runs in, as its catalog metadata records it. */
	cwd: string;
	projectId?: string;
	archivedAt?: number;
	workEndedAt?: number;
	/** `host` for a Session this server owns. */
	source: SessionSource;
	/** The display name `/name` reads, when the session has one. */
	name?: string;
}

export interface SessionCreateOptions {
	id?: string;
	projectId?: string;
	/** UI new-session intent: reuse the latest empty session in this workspace. Cannot accompany `id`. */
	reuseEmpty?: boolean;
}

export interface SessionDirectoryState {
	revision: number;
	sessions: SessionSummary[];
	projects?: ProjectSummary[];
	defaultProjectId?: string;
}

export interface SessionDirectory {
	readonly state: ReplicatedState<SessionDirectoryState>;
}

export const SessionDirectory = remoteService<SessionDirectory>("amazme.session-directory", {}, ["state"]);

export interface SessionManagement {
	create(options: SessionCreateOptions, context: Context): Promise<SessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
	/**
	 * Set the display name `/name` reads, or clear it when `name` is blank. The returned summary is
	 * the session as the roster now lists it.
	 */
	rename(sessionId: string, name: string, context: Context): Promise<SessionSummary>;
}

export const SessionManagement = remoteService<SessionManagement>("amazme.session-management", {"create":1,"remove":1,"attach":1,"detach":0,"rename":2}, []);
