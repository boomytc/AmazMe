/**
 * The session a page URL asks for, if any.
 *
 * A deep link is explicit, so it outranks this tab's remembered selection and the host's
 * last saved one. Values are trimmed; empty or malformed URLs simply have no link.
 */
export interface SessionDeepLink {
	readonly sessionId?: string;
	readonly projectId?: string;
}

export function sessionDeepLink(href: string, base?: string): SessionDeepLink | undefined {
	try {
		const params = new URL(href, base).searchParams;
		const sessionId = params.get("session")?.trim();
		const projectId = params.get("project")?.trim();
		if ((sessionId === undefined || sessionId.length === 0) && (projectId === undefined || projectId.length === 0)) {
			return undefined;
		}
		return {
			...(projectId === undefined || projectId.length === 0 ? {} : { projectId }),
			...(sessionId === undefined || sessionId.length === 0 ? {} : { sessionId }),
		};
	} catch {
		return undefined;
	}
}
