/** Image-only terminal pastes can arrive as an empty bracketed-paste notification. */
export function isEmptyTerminalPaste(data: string): boolean {
	return data === "\x1b[200~\x1b[201~";
}

export function getTerminalPasteText(data: string): string | undefined {
	if (!data.startsWith("\x1b[200~") || !data.endsWith("\x1b[201~")) return undefined;
	return data.slice(6, -6);
}
