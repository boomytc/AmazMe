import { type Context, defineService, type ReplicatedState } from "@amazme/chord";
import type { ServerId } from "@amazme/protocol";

export interface SessionAddress {
	serverId: ServerId;
	sessionId: string;
}

/** Where a listed session lives: a Session this host owns, or a terminal session it can adopt. */
export type SessionSource = "host" | "local";

export interface SessionSummary extends SessionAddress {
	createdAt: number;
	/** The working directory the Session's agent runs in, as its catalog metadata records it. */
	cwd: string;
	/**
	 * `host` for a Session this server owns, `local` for a terminal session that no host has opened
	 * yet. Attaching a `local` one adopts it: the host stores it and seeds it from its transcript.
	 */
	source: SessionSource;
	/** The display name `/name` reads, when the session has one. */
	name?: string;
}

export interface SessionCreateOptions {
	id?: string;
	/** UI new-session intent: reuse the latest empty session in this workspace. Cannot accompany `id`. */
	reuseEmpty?: boolean;
}

export interface SessionDirectoryState {
	revision: number;
	sessions: SessionSummary[];
}

export interface SessionDirectory {
	readonly state: ReplicatedState<SessionDirectoryState>;
}

export const SessionDirectory = defineService<SessionDirectory>("amazme.session-directory");

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

export const SessionManagement = defineService<SessionManagement>("amazme.session-management");
