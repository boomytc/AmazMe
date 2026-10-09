import { defineFacet } from "@amazme/chord";
import type { Facet } from "@amazme/chord";
import { SlashCommands } from "./slash-commands.ts";
import type { SlashCommandContribution } from "./slash-commands.ts";

interface RegisteredSlashCommand {
	readonly command: SlashCommandContribution;
	closed: boolean;
}

export class SlashCommandRegistry implements SlashCommands {
	readonly #commands = new Map<string, RegisteredSlashCommand[]>();
	readonly #listeners = new Set<(commands: readonly SlashCommandContribution[]) => void>();
	readonly #reserved: ReadonlySet<string>;
	#closed = false;

	constructor(reserved: readonly string[] = []) {
		this.#reserved = new Set(reserved);
	}

	register(command: SlashCommandContribution): () => void {
		this.#validate(command);
		if (this.#commands.has(command.name)) throw new Error(`Slash command /${command.name} is already registered`);
		return this.#add(command);
	}

	replace(command: SlashCommandContribution): () => void {
		this.#validate(command);
		return this.#add(command);
	}

	list(): readonly SlashCommandContribution[] {
		return Object.freeze([...this.#commands.values()].map((entries) => entries[0]!.command));
	}

	subscribe(listener: (commands: readonly SlashCommandContribution[]) => void): () => void {
		this.#listeners.add(listener);
		listener(this.list());
		return () => this.#listeners.delete(listener);
	}

	#add(command: SlashCommandContribution): () => void {
		const entry: RegisteredSlashCommand = { command: Object.freeze({ ...command }), closed: false };
		const entries = this.#commands.get(command.name) ?? [];
		entries.push(entry);
		this.#commands.set(command.name, entries);
		if (entries.length === 1) this.#publish();
		return () => {
			if (entry.closed) return;
			entry.closed = true;
			if (entries[0] !== entry) return;
			while (entries[0]?.closed) entries.shift();
			if (entries.length === 0) this.#commands.delete(command.name);
			this.#publish();
		};
	}

	#validate(command: SlashCommandContribution): void {
		if (this.#closed) throw new Error("Command registry is closed");
		if (!/^[a-z0-9][a-z0-9:-]*$/u.test(command.name)) {
			throw new TypeError(`Invalid slash command name: ${command.name}`);
		}
		if (this.#reserved.has(command.name)) throw new Error(`Slash command /${command.name} belongs to the application`);
	}

	#publish(): void {
		const commands = this.list();
		for (const listener of this.#listeners) listener(commands);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const entries of this.#commands.values()) for (const entry of entries) entry.closed = true;
		this.#commands.clear();
		this.#publish();
		this.#listeners.clear();
	}
}

export function createSlashCommandsRuntimeFacet(registry = new SlashCommandRegistry()): Facet {
	return defineFacet({
		id: "@amazme/slash-commands-runtime",
		setup(env) {
			env.provide(SlashCommands, registry);
			env.own(() => registry.close());
		},
	});
}
