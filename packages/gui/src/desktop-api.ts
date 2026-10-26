import type { DesktopPreferences } from "./lifecycle.ts";
import { DEFAULT_DESKTOP_PREFERENCES } from "./lifecycle.ts";
import { readControlToken, type PythonReady } from "./python-backend.ts";

const REQUEST_TIMEOUT_MS = 15_000;

interface SettingsSnapshot {
	readonly preferences: DesktopPreferences;
	readonly revision: number;
	readonly raw: Readonly<Record<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("desktop backend returned an invalid object");
	return value as Record<string, unknown>;
}

function preferences(value: unknown): DesktopPreferences {
	const raw = record(value);
	return {
		closeWindow: raw.closeWindow === "quit" ? "quit" : DEFAULT_DESKTOP_PREFERENCES.closeWindow,
		closeWindowPrompt: raw.closeWindowPrompt === false ? false : DEFAULT_DESKTOP_PREFERENCES.closeWindowPrompt,
	};
}

function settings(value: unknown): SettingsSnapshot {
	const root = record(value);
	const revision = root.revision ?? 0;
	if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) throw new Error("desktop settings revision is invalid");
	return { preferences: preferences(root.preferences ?? {}), revision, raw: record(root.preferences ?? {}) };
}

export class PythonDesktopApi {
	private readonly ready: () => PythonReady | undefined;
	private readonly profile: () => string;
	private readonly webToken: () => string;
	private readonly fetcher: typeof fetch;

	constructor(
		ready: () => PythonReady | undefined,
		profile: () => string,
		webToken: () => string,
		fetcher: typeof fetch = fetch,
	) {
		this.ready = ready;
		this.profile = profile;
		this.webToken = webToken;
		this.fetcher = fetcher;
	}

	private host(): PythonReady {
		const ready = this.ready();
		if (ready === undefined || this.profile().length === 0 || this.webToken().length === 0) throw new Error("desktop backend is not ready");
		return ready;
	}

	private async json(url: string, init: RequestInit): Promise<unknown> {
		const response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`desktop backend request failed (${String(response.status)})`);
		}
		return response.json() as Promise<unknown>;
	}

	async activity(): Promise<{ readonly active: boolean }> {
		const ready = this.host();
		const value = record(await this.json(`${ready.origin}/control/desktop/activity`, {
			headers: { Authorization: `Bearer ${readControlToken(this.profile())}` },
		}));
		if (typeof value.active !== "boolean") throw new Error("desktop activity response is invalid");
		return { active: value.active };
	}

	async readPreferences(): Promise<DesktopPreferences> {
		return (await this.snapshot()).preferences;
	}

	private async snapshot(): Promise<SettingsSnapshot> {
		const ready = this.host();
		return settings(await this.json(`${ready.origin}/api/v1/settings`, {
			headers: { Authorization: `Bearer ${this.webToken()}` },
		}));
	}

	async savePreferences(value: DesktopPreferences): Promise<void> {
		const ready = this.host();
		const current = await this.snapshot();
		const updated = settings(await this.json(`${ready.origin}/api/v1/settings/preferences`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${this.webToken()}`,
				"content-type": "application/json",
				"x-amazme-build": ready.buildId,
				"x-amazme-epoch": String(ready.hostEpoch),
			},
			body: JSON.stringify({
				preferences: { ...current.raw, closeWindow: value.closeWindow, closeWindowPrompt: value.closeWindowPrompt },
				expected_revision: current.revision,
			}),
		}));
		if (updated.preferences.closeWindow !== value.closeWindow || updated.preferences.closeWindowPrompt !== value.closeWindowPrompt) {
			throw new Error("desktop settings acknowledgement is invalid");
		}
	}
}
