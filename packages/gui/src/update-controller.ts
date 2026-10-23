import type { UpdateAsset, UpdateChannel, UpdateManifest } from "./update-manifest.ts";

export type UpdateErrorCode = "network" | "manifest" | "source" | "integrity" | "signature" | "unsupported" | "permission" | "busy" | "install";
export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "verifying" | "ready" | "installing" | "error";
export interface UpdateState {
	readonly phase: UpdatePhase;
	readonly current: string;
	readonly channel: UpdateChannel;
	readonly version?: string;
	readonly received?: number;
	readonly total?: number;
	readonly error?: UpdateErrorCode;
}
export interface PreparedUpdate { readonly directory: string }
export interface DesktopUpdateIO {
	check(channel: UpdateChannel, signal: AbortSignal): Promise<{ manifest: UpdateManifest; asset: UpdateAsset } | undefined>;
	download(asset: UpdateAsset, signal: AbortSignal, progress: (received: number, total: number) => void): Promise<string>;
	verify(file: string, manifest: UpdateManifest, signal: AbortSignal): Promise<PreparedUpdate>;
	discard(file: string | undefined, prepared: PreparedUpdate | undefined): Promise<void>;
	install(prepared: PreparedUpdate): Promise<void>;
}
export function updateError(error: unknown): UpdateErrorCode {
	const code = error instanceof Error ? error.message : "";
	return ["network", "manifest", "source", "integrity", "signature", "unsupported", "permission", "busy", "install"].includes(code) ? code as UpdateErrorCode : "network";
}

/** No download on check, and no installation on download or ordinary app quit. */
export function createUpdateController(current: string, io: DesktopUpdateIO, changed: (state: UpdateState) => void) {
	let state: UpdateState = { phase: "idle", current, channel: "stable" };
	let available: { manifest: UpdateManifest; asset: UpdateAsset } | undefined;
	let prepared: PreparedUpdate | undefined;
	let flight: Promise<void> | undefined;
	let abort: AbortController | undefined;
	const set = (next: Partial<UpdateState>): void => { state = { current, channel: state.channel, ...next } as UpdateState; changed(state); };
	const run = (operation: () => Promise<void>): Promise<void> => {
		if (flight) return flight;
		flight = operation().finally(() => { flight = undefined; });
		return flight;
	};
	return {
		state: () => state,
		check(channel: UpdateChannel = state.channel): Promise<void> {
			if (prepared || state.phase === "installing") return Promise.resolve();
			return run(async () => {
				abort = new AbortController();
				available = undefined;
				set({ phase: "checking", channel });
				try {
					available = await io.check(channel, abort.signal);
					set(available ? { phase: "available", version: available.manifest.version } : { phase: "idle" });
				} catch (error) { set(abort.signal.aborted ? { phase: "idle" } : { phase: "error", error: updateError(error) }); }
			});
		},
		download(): Promise<void> {
			if (!available || !["available", "error"].includes(state.phase)) return flight ?? Promise.resolve();
			const release = available;
			return run(async () => {
				abort = new AbortController();
				let file: string | undefined;
				set({ phase: "downloading", version: release.manifest.version, received: 0, total: release.asset.size });
				try {
					file = await io.download(release.asset, abort.signal, (received, total) => set({ phase: "downloading", version: release.manifest.version, received, total }));
					abort.signal.throwIfAborted();
					set({ phase: "verifying", version: release.manifest.version });
					prepared = await io.verify(file, release.manifest, abort.signal);
					abort.signal.throwIfAborted();
					set({ phase: "ready", version: release.manifest.version });
				} catch (error) {
					await io.discard(undefined, prepared); prepared = undefined;
					set(abort.signal.aborted ? { phase: "available", version: release.manifest.version } : { phase: "error", version: release.manifest.version, error: updateError(error) });
				} finally { await io.discard(file, undefined); }
			});
		},
		cancel(): void { if (["checking", "downloading", "verifying"].includes(state.phase)) abort?.abort(); },
		install(): Promise<void> {
			if (!prepared || state.phase !== "ready") return flight ?? Promise.resolve();
			const candidate = prepared;
			return run(async () => {
				set({ phase: "installing", version: state.version });
				try { await io.install(candidate); }
				catch (error) { set({ phase: "ready", version: state.version, ...(error instanceof Error && error.message === "postponed" ? {} : { error: updateError(error) }) }); }
			});
		},
		async dispose(): Promise<void> {
			if (state.phase === "installing") return;
			abort?.abort(); await flight;
			// An installer owns its prepared directory once handed off.
			await io.discard(undefined, prepared);
		},
	};
}
