import { createHost, type Facet, type FacetLoader, type Host } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { ServiceHost } from "@amazme/protocol/services";
import type { Harness } from "@amazme/durable";

export interface PluginRuntime {
	readonly host: Host;
	readonly services: ServiceHost;
	readonly changing: boolean;
	reload(): Promise<void>;
	close(): Promise<void>;
}

/** Chord owns resource cutover and rollback; the application serializes reload with shutdown. */
export async function openPluginRuntime(
	builtins: readonly Facet[],
	loader: FacetLoader,
	beforeReload?: () => Promise<void>,
): Promise<PluginRuntime> {
	const host = createHost({ name: "plugins" });
	const services = new ServiceHost(host.name, host);
	let plugins: Facet[];
	try {
		plugins = await loader([]);
		await host.load([...builtins, ...plugins]);
	} catch (error) {
		await host.close();
		throw error;
	}
	let tail = Promise.resolve();
	let closing: Promise<void> | undefined;
	let pending = 0;
	return {
		host,
		services,
		get changing() {
			return closing !== undefined || pending > 0;
		},
		reload() {
			if (closing) return Promise.reject(new Error("Plugin runtime is closing"));
			pending++;
			const operation = tail
				.then(async () => {
					await beforeReload?.();
					const candidate = await loader([]);
					await beforeReload?.();
					const names = new Set(candidate.map((facet) => facet.name));
					await host.reload(candidate, {
						remove: plugins.filter((facet) => !names.has(facet.name)).map((facet) => facet.name),
					});
					plugins = candidate;
				})
				.finally(() => {
					pending--;
				});
			tail = operation.catch(() => {});
			return operation;
		},
		close() {
			return (closing ??= tail.then(() => services.dispose()));
		},
	};
}

/** A registry change waits for an explicit idle session rather than retiring code used by a live tool. */
export async function assertPluginsIdle(harness: Harness): Promise<void> {
	const graph = await harness.taskGraph(BACKGROUND_CONTEXT);
	try {
		if (Object.keys(graph.value.tasks).length > 0)
			throw new Error("Finish or abort active tasks before reloading plugins");
	} finally {
		graph.dispose();
	}
}
