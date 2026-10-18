import type { SettingsManager } from "./settings-manager.ts";

export interface RuntimeDiagnostic {
	type: "error" | "warning" | "info";
	message: string;
}

export function collectSettingsDiagnostics(settingsManager: SettingsManager): RuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, path, error }) => {
		const detail = error instanceof SyntaxError ? "malformed JSON" : error.message;
		return {
			type: "warning",
			message: path ? `Invalid settings file ${path}: ${detail}` : `Invalid ${scope} settings: ${detail}`,
		};
	});
}

/**
 * Remove duplicate type/message diagnostics while preserving their first occurrence.
 * Startup and runtime settings managers can report the same file error.
 */
export function deduplicateDiagnostics(
	diagnostics: readonly RuntimeDiagnostic[],
): RuntimeDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
