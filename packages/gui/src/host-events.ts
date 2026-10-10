/** Exit data crosses from Node supervision into presentation; future signal names remain diagnostics. */
export interface HostExitDetail {
	readonly code: number | null;
	readonly signal: string | null;
	readonly tail: string;
}
