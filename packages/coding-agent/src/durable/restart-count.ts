/**
 * The configured restart bound as a presentation may show it: a finite number, or `undefined` when the bound is off.
 * `settings.restartLimit` turns the bound off with `Infinity`, which a JSON hop carries as `null`, so both read as off.
 */
export function finiteRestartLimit(
	limit: number | null | undefined,
): number | undefined {
	return typeof limit === "number" && Number.isFinite(limit)
		? limit
		: undefined;
}

/** `3/5` while the bound is on; `3` when it is off. */
export function formatRestartCount(
	restarts: number,
	limit: number | null | undefined,
): string {
	const bound = finiteRestartLimit(limit);
	return bound === undefined
		? String(restarts)
		: `${String(restarts)}/${String(bound)}`;
}
