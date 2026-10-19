import { join } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@amazme/ai";
import type { EntryRecord } from "@amazme/durable";
import {
	bugReportArchiveFileName,
	collectBugReportDiagnostics,
	collectBugReportMetadata,
	generateBugReportSummary,
	redactUrl,
	writeBugReportArchive,
	type BugReportSessionEntryData,
} from "../core/bug-report.ts";
import { uploadBugReport } from "../core/bug-report-upload.ts";
import { clearCrashLog, readCrashLog } from "../core/crash-log.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { durableEntriesToSessionFile } from "../core/session-interop.ts";
import { getAuthCredential } from "../cli/auth-command.ts";
import { sessionEntriesFor } from "./session-surface.ts";

export interface DurableBugReportOptions {
	readonly hint?: string;
	readonly content: "diagnostics" | "summary" | "session";
	readonly delivery: "zip" | "upload";
}

/** Called only after the presentation has selected content and delivery. */
export async function deliverDurableBugReport(
	options: DurableBugReportOptions & {
		readonly entries: readonly EntryRecord[];
		readonly sessionId: string;
		readonly cwd: string;
		readonly model?: Model<Api>;
		readonly thinkingLevel: ModelThinkingLevel;
		readonly models: ModelRuntime;
		readonly settings: SettingsManager;
		readonly pluginSources: readonly string[];
		readonly signal: AbortSignal;
	},
): Promise<{ note: string; record: BugReportSessionEntryData }> {
	if (options.delivery === "upload" && process.env.AMAZME_OFFLINE !== undefined) {
		throw new Error("Uploading bug reports requires online mode. Export a ZIP instead.");
	}
	options.signal.throwIfAborted();
	const entries = sessionEntriesFor(options.entries);
	const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	let summary: string | undefined;
	if (options.content === "summary") {
		if (!options.model) throw new Error("No model available for a bug report summary");
		summary = await generateBugReportSummary({
			messages,
			hint: options.hint,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			sessionId: options.sessionId,
			signal: options.signal,
			streamFn: (model, context, request) => options.models.streamSimple(model, context, request),
		});
	}
	const includeSession = options.content === "session";
	const crashes = readCrashLog();
	const clearDeliveredCrashes = (): void => {
		// A new crash while uploading belongs to the next report.
		if (crashes.length > 0 && JSON.stringify(readCrashLog()) === JSON.stringify(crashes)) clearCrashLog();
	};
	const bundle = {
		metadata: {
			...collectBugReportMetadata({
				hint: options.hint,
				sessionId: options.sessionId,
				cwd: options.cwd,
				includeSession,
				includeSummary: summary !== undefined,
				messageCount: messages.length,
				model: options.model,
				modelRuntime: options.models,
				thinkingLevel: options.thinkingLevel,
				extensions: [],
				extensionErrors: [],
				globalSettings: options.settings.getGlobalSettings(),
				projectSettings: options.settings.getProjectSettings(),
			}),
			pluginSources: options.pluginSources.map(redactUrl),
		},
		diagnostics: collectBugReportDiagnostics({ getEntries: () => entries }, crashes, options.sessionId),
		summary,
		sessionJsonl: includeSession
			? `${durableEntriesToSessionFile(options.entries, {
					id: options.sessionId,
					cwd: options.cwd,
					timestamp: new Date().toISOString(),
				})
					.entries.map((entry) => JSON.stringify(entry))
					.join("\n")}\n`
			: undefined,
	};
	options.signal.throwIfAborted();
	const record: BugReportSessionEntryData = {
		id: bundle.metadata.id,
		createdAt: bundle.metadata.createdAt,
		hint: bundle.metadata.hint,
		sessionIncluded: includeSession,
		summaryIncluded: summary !== undefined,
		delivery: options.delivery,
	};
	if (options.delivery === "upload") {
		const token = options.models.getProvider("radius")
			? getAuthCredential(await options.models.getAuth("radius", { signal: options.signal }))
			: undefined;
		const result = await uploadBugReport(bundle, { token, signal: options.signal });
		clearDeliveredCrashes();
		return { note: `Bug report uploaded. Report ID: ${result.id}`, record };
	}
	const path = join(options.cwd, bugReportArchiveFileName(record.id));
	await writeBugReportArchive(bundle, path);
	clearDeliveredCrashes();
	return { note: `Bug report exported to: ${path}\nReport ID: ${record.id}`, record: { ...record, path } };
}
