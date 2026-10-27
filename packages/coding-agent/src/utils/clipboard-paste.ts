/** Image-only terminal pastes can arrive as an empty bracketed-paste notification. */
export function isEmptyTerminalPaste(data: string): boolean {
	return data === "\x1b[200~\x1b[201~";
}
