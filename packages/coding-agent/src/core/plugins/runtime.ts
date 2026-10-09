import { createFacetHost, type Facet, type FacetHost, type FacetLoader, type LoadedFacets } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { Harness } from "@amazme/durable";

export interface PluginRuntime {
	readonly services: FacetHost["services"];
	readonly changing: boolean;
	reload(): Promise<void>;
	close(): Promise<void>;
}

/** One application-owned loader and Chord host; unchanged service handles survive a successful reload. */
export async function openPluginRuntime(
	builtins: readonly Facet[],
	loader: FacetLoader,
	beforeReload?: () => Promise<void>,
): Promise<PluginRuntime> {
	let loaded: LoadedFacets = await loader.load();
	let host: FacetHost;
	try {
		host = await createFacetHost({ facets: [...builtins, ...loaded.facets] });
	} catch (error) {
		try {
			await loaded.dispose();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Plugin startup and cleanup failed");
		}
		throw error;
	}
	let tail = Promise.resolve();
	let closing: Promise<void> | undefined;
	let pending = 0;
	return {
		services: host.services,
		get changing() {
			return closing !== undefined || pending > 0 || !host.active;
		},
		reload() {
			if (closing !== undefined) return Promise.reject(new Error("Plugin runtime is closing"));
			pending += 1;
			const operation = tail.then(async () => {
				await beforeReload?.();
				const candidate = await loader.load();
				try {
					await beforeReload?.();
					await host.reload(candidate.facets);
				} catch (error) {
					try {
						await candidate.dispose();
					} catch (cleanup) {
						throw new AggregateError([error, cleanup], "Plugin reload and cleanup failed");
					}
					throw error;
				}
				const retired = loaded;
				loaded = candidate;
				await retired.dispose();
			}).finally(() => {
				pending -= 1;
			});
			tail = operation.catch(() => {});
			return operation;
		},
		close() {
			closing ??= (async () => {
				await tail;
				const errors: unknown[] = [];
				try {
					await host.dispose();
				} catch (error) {
					errors.push(error);
				}
				try {
					await loaded.dispose();
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "Plugin cleanup failed");
			})();
			return closing;
		},
	};
}

/** A registry change waits for an explicit idle session rather than retiring code used by a live tool. */
export async function assertPluginsIdle(harness: Harness): Promise<void> {
	const graph = await harness.taskGraph(BACKGROUND_CONTEXT);
	try {
		if (Object.keys(graph.value.tasks).length > 0) throw new Error("Finish or abort active tasks before reloading plugins");
	} finally {
		graph.dispose();
	}
}
