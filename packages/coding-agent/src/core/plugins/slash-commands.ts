import { localService } from "@amazme/protocol/services";
import type { Context } from "@amazme/chord";
import type { AgentOperationResponse, AgentQueueResponse } from "./agent-controller.ts";

export interface SlashCommandCompletion {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export type SlashCommandRunResult =
	| AgentOperationResponse
	| AgentQueueResponse
	/** A finished command with something to show, such as a share URL. */
	| { readonly note: string }
	| undefined;

export interface SlashCommandContribution {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
	getArgumentCompletions?(
		argumentPrefix: string,
	): readonly SlashCommandCompletion[] | null | Promise<readonly SlashCommandCompletion[] | null>;
	/** Pass this context to asynchronous agent work and respond to its cancellation signal. */
	run(args: string, context: Context): SlashCommandRunResult | Promise<SlashCommandRunResult>;
}

export interface SlashCommands {
	register(command: SlashCommandContribution): () => void;
	/** Stage a same-name replacement while the previous facet generation retires. */
	replace(command: SlashCommandContribution): () => void;
	list(): readonly SlashCommandContribution[];
	subscribe(listener: (commands: readonly SlashCommandContribution[]) => void): () => void;
}

export const SlashCommands = localService<SlashCommands>("amazme.local.slash-commands");
