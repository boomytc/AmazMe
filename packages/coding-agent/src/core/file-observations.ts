import { randomUUID } from "node:crypto";
import type { FileObservation, FileObservationState } from "@amazme/durable/file-observations";
import { fileObservationKey, recordFileObservation } from "@amazme/durable/file-observations";
import type { SessionManager } from "./session-manager.ts";

const FILE_OBSERVATION_ENTRY = "amazme.file-observation";

export interface FileObservationScope {
	get(namespace: string, path: string): FileObservation | undefined;
	record(namespace: string, path: string, observation: FileObservation | undefined): Promise<void>;
}

export interface FileObservationStore {
	/** Capture the actual owner before starting asynchronous IO. */
	capture(): FileObservationScope;
}

export function createMemoryFileObservations(): FileObservationStore {
	const state: FileObservationState = { files: {} };
	return {
		capture: () => ({
			get: (namespace, path) => copyObservation(state.files[fileObservationKey(namespace, path)]),
			record: async (namespace, path, observation) => recordFileObservation(state, namespace, path, observation),
		}),
	};
}

function copyObservation(value: FileObservation | undefined): FileObservation | undefined {
	return value === undefined ? undefined : { ...value };
}

type ObservationEntry = {
	version: 1;
	sessionId: string;
	scopeId: string;
	namespace: string;
	path: string;
	observation: FileObservation | null;
};

function observationEntry(value: unknown): ObservationEntry | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const data = value as Record<string, unknown>;
	if (
		data.version !== 1 ||
		typeof data.sessionId !== "string" ||
		typeof data.scopeId !== "string" ||
		typeof data.namespace !== "string" ||
		typeof data.path !== "string"
	)
		return undefined;
	const observation = data.observation;
	if (
		observation !== null &&
		(typeof observation !== "object" ||
			observation === null ||
			!("kind" in observation) ||
			(observation.kind !== "absent" &&
				(observation.kind !== "present" || !("version" in observation) || typeof observation.version !== "string")))
	)
		return undefined;
	return data as ObservationEntry;
}

/** The JSONL journal is authoritative. This cache is a bounded projection of the current branch only. */
class SessionFileObservations implements FileObservationStore {
	readonly #manager: SessionManager;
	#identity = "";
	#revision = -1;
	#scopeId: string = randomUUID();
	#state: FileObservationState = { files: {} };

	constructor(manager: SessionManager) {
		this.#manager = manager;
	}

	capture(): FileObservationScope {
		this.#refresh();
		const identity = this.#identity;
		const revision = this.#revision;
		const sessionId = this.#manager.getSessionId();
		const state = this.#state;
		const scopeId = this.#scopeId;
		const current = () => identity === this.#currentIdentity() && revision === this.#manager.getContextRevision();
		return {
			get: (namespace, path) => {
				if (!current()) throw new Error("File observation scope changed; obtain the current session context");
				return copyObservation(state.files[fileObservationKey(namespace, path)]);
			},
			record: async (namespace, path, observation) => {
				if (!current())
					throw new Error("File observation scope changed; the completed IO cannot update another session or branch");
				const saved = copyObservation(observation);
				this.#manager.appendCustomEntry(FILE_OBSERVATION_ENTRY, {
					version: 1,
					sessionId,
					scopeId,
					namespace,
					path,
					observation: saved ?? null,
				} satisfies ObservationEntry);
				recordFileObservation(state, namespace, path, saved);
			},
		};
	}

	#currentIdentity(): string {
		return JSON.stringify([this.#manager.getSessionId(), this.#manager.getSessionFile() ?? null]);
	}

	#refresh(): void {
		const identity = this.#currentIdentity();
		const revision = this.#manager.getContextRevision();
		if (identity === this.#identity && revision === this.#revision) return;
		const changedBranch = this.#identity === identity;
		this.#scopeId = randomUUID();
		this.#identity = identity;
		this.#revision = revision;
		this.#state = { files: {} };
		if (changedBranch) return;
		const entries = this.#manager.getEntries();
		// A historical selection starts a new working branch; do not borrow the old path's observations.
		if (this.#manager.getLeafId() !== (entries.at(-1)?.id ?? null)) return;
		const positions = new Map(entries.map((entry, index) => [entry.id, index]));
		const branch = this.#manager.getBranch();
		let start = 0;
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i]!;
			const position = positions.get(entry.id)!;
			if (position > 0 && entry.parentId !== entries[position - 1]!.id) start = i;
		}
		const records = branch.slice(start).flatMap((entry) => {
			if (entry.type !== "custom" || entry.customType !== FILE_OBSERVATION_ENTRY) return [];
			const data = observationEntry(entry.data);
			return data?.sessionId === this.#manager.getSessionId() ? [data] : [];
		});
		const latest = records.at(-1);
		if (latest === undefined) return;
		this.#scopeId = latest.scopeId;
		for (const data of records) {
			if (data.scopeId === this.#scopeId)
				recordFileObservation(this.#state, data.namespace, data.path, data.observation ?? undefined);
		}
	}
}

const stores = new WeakMap<SessionManager, FileObservationStore>();

/** Reloaded runners sharing the same actual manager share its projection, never a cwd-based cache. */
export function sessionFileObservations(manager: SessionManager): FileObservationStore {
	let store = stores.get(manager);
	if (store === undefined) {
		store = new SessionFileObservations(manager);
		stores.set(manager, store);
	}
	return store;
}
