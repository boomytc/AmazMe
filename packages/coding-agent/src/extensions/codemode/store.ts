import type { SessionEntry } from "../../core/session-manager.ts";
import { CODEMODE_STORE_ENTRY_TYPE } from "../../core/codemode/declarations.ts";
import type { CodemodeStoreWrites as CodemodeStoreEntryData } from "../../core/codemode/types.ts";

function isStoreEntryData(data: unknown): data is CodemodeStoreEntryData {
	if (typeof data !== "object" || data === null) return false;
	const { set, delete: deleted } = data as Partial<CodemodeStoreEntryData>;
	return (
		typeof set === "object" &&
		set !== null &&
		Array.isArray(deleted) &&
		deleted.every((key: unknown) => typeof key === "string")
	);
}

/** Values of `load()`: the `codemode-store` entries on the branch, applied from the root. */
export function readCodemodeStore(branch: readonly SessionEntry[]): Record<string, unknown> {
	const store = new Map<string, unknown>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODEMODE_STORE_ENTRY_TYPE || !isStoreEntryData(entry.data)) {
			continue;
		}
		for (const key of entry.data.delete) store.delete(key);
		for (const [key, value] of Object.entries(entry.data.set)) store.set(key, value);
	}
	return Object.fromEntries(store);
}
