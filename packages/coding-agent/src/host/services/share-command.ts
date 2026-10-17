import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Facet } from "@amazme/chord";
import { activationFacet } from "@amazme/protocol/services";
import type { Conversation } from "@amazme/durable";
import { SlashCommands } from "../../core/plugins/slash-commands.ts";
import { getAuthCredential } from "../../cli/auth-command.ts";
import {
	shareFilesToUrl,
	type ShareDestination,
	type ShareOutcome,
} from "../../core/session-share.ts";
import { writeDurableExport } from "../../durable/export.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";

export interface ShareCommandOptions {
	readonly conversation: Conversation;
	readonly cwd: string;
	/** Read at run time, so a settings change applies to the next share. */
	readonly destination: () => ShareDestination;
	readonly modelRuntime?: ModelRuntime;
	/** Injectables for tests: export both files, and perform the upload. */
	readonly exportEntries?: (files: { readonly jsonlFile: string; readonly htmlFile: string }) => Promise<void>;
	readonly share?: (files: {
		readonly jsonlFile: string;
		readonly htmlFile: string;
		readonly destination: ShareDestination;
		readonly radiusToken?: () => Promise<string | undefined>;
	}) => Promise<ShareOutcome>;
}

function radiusToken(modelRuntime: ModelRuntime | undefined): () => Promise<string | undefined> {
	return async () => {
		if (modelRuntime?.getProvider("radius") === undefined) return undefined;
		return getAuthCredential(await modelRuntime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 }));
	};
}

/**
 * `/share` for a Durable conversation.
 *
 * The browser session is a conversation, not an AgentSession, so the command exports the
 * active transcript with the durable exporter and hands both formats to the shared uploader.
 * The URL is shown through the presentation status line; a failure throws, and the command
 * runner reports the reason on the connection line.
 */
export function createShareCommand(options: ShareCommandOptions) {
	return {
		name: "share",
		description: "Share this session (Radius or private gist)",
		async run(_args: string, context: Context): Promise<{ readonly note: string }> {
			const directory = await mkdtemp(join(tmpdir(), "amazme-share-"));
			const jsonlFile = join(directory, "session.jsonl");
			const htmlFile = join(directory, "session.html");
			try {
				const view = await options.conversation.viewState(context);
				const entries = view.value.entries;
				view.dispose();
				if (options.exportEntries !== undefined) {
					await options.exportEntries({ jsonlFile, htmlFile });
				} else {
					const id = String(options.conversation.id);
					await writeDurableExport(entries, {
						id,
						cwd: options.cwd,
						output: jsonlFile,
						format: "jsonl",
					});
					await writeDurableExport(entries, {
						id,
						cwd: options.cwd,
						output: htmlFile,
						format: "html",
					});
				}
				const destination = options.destination();
				const outcome = await (options.share ?? shareFilesToUrl)({
					jsonlFile,
					htmlFile,
					destination,
					radiusToken: radiusToken(options.modelRuntime),
				});
				if (!outcome.ok) throw new Error(outcome.problem);
				const gist = outcome.gistUrl === undefined ? "" : ` · Gist: ${outcome.gistUrl}`;
				return { note: `Share URL: ${outcome.url}${gist}` };
			} finally {
				await rm(directory, { recursive: true, force: true }).catch(() => {});
			}
		},
	};
}

/** Registers `/share` with the session's command registry. */
export function createShareCommandFacet(options: ShareCommandOptions): Facet {
	return activationFacet("@pi/share", [SlashCommands], async (services) => {
		const commands = services.get(SlashCommands);
		const dispose = commands.register(createShareCommand(options));
		return () => dispose();
	});
}
