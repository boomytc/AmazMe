/** The prompts one host session submitted, recalled by the composer with the arrow keys. */
const LIMIT = 100;

function read(key: string): readonly string[] {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item): item is string => typeof item === "string")
			.slice(-LIMIT);
	} catch {
		return [];
	}
}

export class PromptHistory {
	private entries: readonly string[] = [];
	private key?: string;
	/** Point the history at one host session; repeating the same key keeps the loaded list. */
	select(key: string): void {
		if (this.key === key) return;
		this.key = key;
		this.entries = read(key);
	}
	list(): readonly string[] {
		return this.entries;
	}
	/** Remember an accepted prompt. A repeated prompt moves to the newest position. */
	record(text: string): void {
		const value = text.trim();
		if (!this.key || value.length === 0 || this.entries.at(-1) === value) return;
		this.entries = [...this.entries.filter((entry) => entry !== value), value].slice(-LIMIT);
		try {
			localStorage.setItem(this.key, JSON.stringify(this.entries));
		} catch {
			// Storage can be unavailable; the in-memory recall still works for this window.
		}
	}
}
