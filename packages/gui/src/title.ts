/**
 * Pending approvals carried on the page title.
 *
 * The shell reads a leading `(n) ` and nothing else: no preload and no IPC. The page writes that
 * prefix only for a real pending count, and rewrites a session name that itself starts with
 * `(digits) ` so the name cannot be mistaken for one. Parentheses later in the title are not a count.
 */

/** `(n) ` at the start, with no leading zeros. `(0) ` is a count of none, not a pending mark. */
const PENDING_PREFIX = /^\((0|[1-9]\d*)\) /u;

/**
 * The pending-approval count encoded in a window title. Missing, zero, or not a canonical
 * leading prefix is 0. A count that is not at the start — or that the page rewrote with
 * full-width parentheses — is part of the session name.
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

export interface TitleAttention {
	readonly pending: number;
	/** `true` starts a flash, `false` stops one, `undefined` leaves the frame alone. */
	readonly flash: boolean | undefined;
}

/**
 * The next flash state after a title change. Returning to none stops the flash even if the
 * window is still in the background, so a later real approval can rise from 0 again.
 */
export function attentionOnTitle(previous: number, title: string, focused: boolean): TitleAttention {
	const pending = pendingApprovalCount(title);
	if (shouldFlashFrame(previous, pending, focused)) return { pending, flash: true };
	if (previous > 0 && pending === 0) return { pending, flash: false };
	return { pending, flash: undefined };
}
