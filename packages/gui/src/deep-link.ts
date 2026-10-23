/** Names carried in a desktop window URL. The page binds this session and workspace, not the first row. */
export interface WindowAddress {
	readonly sessionId?: string;
	readonly workspace?: string;
	readonly fresh?: boolean;
}

/**
 * The URL one desktop window opens.
 *
 * `session` and `workspace` are that window's binding. `new=1` tells the page to create a
 * session in the named workspace instead of attaching to whichever conversation is first.
 */
export function withWindowTarget(pageUrl: string, target: WindowAddress = {}): string {
	const sessionId = target.sessionId?.trim();
	const workspace = target.workspace?.trim();
	const namesSession = sessionId !== undefined && sessionId.length > 0;
	const namesWorkspace = workspace !== undefined && workspace.length > 0;
	if (!namesSession && !namesWorkspace && target.fresh !== true) return pageUrl;
	try {
		const url = new URL(pageUrl);
		if (namesSession) url.searchParams.set("session", sessionId);
		if (namesWorkspace) url.searchParams.set("workspace", workspace);
		if (target.fresh === true) url.searchParams.set("new", "1");
		return url.toString();
	} catch {
		return pageUrl;
	}
}

/** The URL a desktop window opens when the caller names a session. */
export function withSessionDeepLink(pageUrl: string, sessionId: string | undefined): string {
	return withWindowTarget(pageUrl, { sessionId });
}
