/** Exact names or patterns where only `*` is special. Shared by host and runtime selection. */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	const patterns = entries
		.filter((entry) => entry.includes("*"))
		.map(
			(entry) =>
				new RegExp(
					`^${entry
						.split("*")
						.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
						.join(".*")}$`,
				),
		);
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}
