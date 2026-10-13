import { serviceFacet, type ServiceValue, disposeResources } from "@amazme/protocol/services";
import { localService } from "@amazme/protocol/services";
import { type Facet } from "@amazme/chord";
import type { Extension, Registry } from "@amazme/durable";

export interface AgentExtensionInfo {
	readonly name: string;
	readonly tools: readonly string[];
	readonly sections: readonly string[];
	readonly tasks: readonly string[];
}

/** Process-local contributions to the same registry the agent executes. */
export interface AgentExtensions {
	/** Return this installation lease from an activationFacet; a replacement becomes visible when its predecessor retires. */
	install(extension: Extension): () => void;
	list(): readonly AgentExtensionInfo[];
}

export const AgentExtensions = localService<AgentExtensions>("amazme.local.agent-extensions");

type Installation = { readonly extension: Extension; closed: boolean };

class AgentExtensionRegistry implements AgentExtensions {
	readonly #registry: Registry;
	readonly #installed = new Map<string, Installation[]>();

	constructor(registry: Registry) {
		this.#registry = registry;
	}

	install(extension: Extension): () => void {
		extension = Object.freeze({
			...extension,
			...(extension.tools === undefined ? {} : { tools: Object.freeze([...extension.tools]) }),
			...(extension.sections === undefined ? {} : { sections: Object.freeze([...extension.sections]) }),
			...(extension.tasks === undefined ? {} : { tasks: Object.freeze([...extension.tasks]) }),
			...(extension.hooks === undefined ? {} : { hooks: Object.freeze([...extension.hooks]) }),
			...(extension.wraps === undefined ? {} : { wraps: Object.freeze([...extension.wraps]) }) });
		const entries = this.#installed.get(extension.name);
		if (entries === undefined && this.#registry.snapshot().extension(extension.name) !== undefined) {
			throw new Error(`Extension ${extension.name} belongs to the application`);
		}
		this.#registry.validate(extension);
		const queue = entries ?? [];
		const entry: Installation = { extension, closed: false };
		if (queue.length === 0) this.#registry.install(extension);
		queue.push(entry);
		this.#installed.set(extension.name, queue);
		return () => {
			if (entry.closed) return;
			entry.closed = true;
			if (queue[0] !== entry) return;
			const owned = this.#registry.snapshot().extension(extension.name) === entry.extension;
			while (queue[0]?.closed) queue.shift();
			if (queue.length > 0 && owned) this.#registry.install(queue[0]!.extension);
			else {
				this.#installed.delete(extension.name);
				if (owned) this.#registry.uninstall(extension);
			}
		};
	}

	list(): readonly AgentExtensionInfo[] {
		return this.#registry.snapshot().installed().map((extension) => ({
			name: extension.name,
			tools: (extension.tools ?? []).map((tool) => tool.name),
			sections: (extension.sections ?? []).map((section) => section.key),
			tasks: (extension.tasks ?? []).map((task) => task.definition.name) }));
	}

	close(): void {
		for (const [name, entries] of this.#installed) {
			if (this.#registry.snapshot().extension(name) === entries[0]?.extension) {
				this.#registry.uninstall(entries[0]!.extension);
			}
			for (const entry of entries) entry.closed = true;
		}
		this.#installed.clear();
	}
}

export function createAgentExtensionsFacet(registry: Registry): Facet {
	return serviceFacet("@amazme/agent-extensions-runtime", AgentExtensions, [], async (services) => {
		const disposers: Array<() => void | Promise<void>> = [];
		try {
			const extensions = new AgentExtensionRegistry(registry);
			const implementation: ServiceValue<typeof AgentExtensions> = extensions;
			disposers.push(() => extensions.close());

			return { value: implementation, close: () => disposeResources(disposers) };
		} catch (error) {
			await disposeResources(disposers);
			throw error;
		}
	});
}
