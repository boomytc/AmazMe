/** Diagnostics are public; authorization URLs are shown separately only during an explicit login. */
export function publicMcpError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error))
		.replace(/https?:\/\/[^\s<>"']+/g, (value) => {
			try {
				const url = new URL(value);
				return `${url.origin}${url.pathname}`;
			} catch {
				return "[URL]";
			}
		})
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.slice(0, 2000);
}
