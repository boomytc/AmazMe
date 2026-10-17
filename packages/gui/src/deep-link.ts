/**
 * The URL a desktop window opens when the caller names a session.
 *
 * The page reads `?session=` and prefers it over its remembered selection, so a deep link
 * reaches one conversation without changing what other windows or tabs last chose.
 */
export function withSessionDeepLink(pageUrl: string, sessionId: string | undefined): string {
	const trimmed = sessionId?.trim();
	if (trimmed === undefined || trimmed.length === 0) return pageUrl;
	try {
		const url = new URL(pageUrl);
		url.searchParams.set("session", trimmed);
		return url.toString();
	} catch {
		return pageUrl;
	}
}
