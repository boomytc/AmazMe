/**
 * Pending approvals carried on the page title.
 *
 * The page prefixes `(n) ` only when n is a positive integer. The shell reads that prefix and
 * nothing else: no preload and no IPC. A session name may itself contain parentheses; only a
 * leading canonical count is the prefix.
 */

/** `(n) ` at the start, with no leading zeros. `(0) ` is a count of none, not a pending mark. */
const PENDING_PREFIX = /^\((0|[1-9]\d*)\) /u;

/**
 * The pending-approval count encoded in a window title. Missing, zero, or not a canonical
 * prefix is 0, so a session name that contains parentheses does not flash the window.
 */
export function pendingApprovalCount(title: string): number {
	const digits = PENDING_PREFIX.exec(title)?.[1];
	if (digits === undefined) return 0;
	const value = Number(digits);
	return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Start the taskbar flash only when the count rises from none to some while the window is not
 * focused. A later increase, or the same rise while focused, does not start one. Focus stops it.
 */
export function shouldFlashFrame(previous: number, next: number, focused: boolean): boolean {
	return previous === 0 && next > 0 && !focused;
}
