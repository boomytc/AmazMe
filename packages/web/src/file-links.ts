/** A local file destination; the host still owns workspace authorization. */
export interface FileLocation {
	readonly path: string;
	readonly line?: number;
}

/** Decode local destinations while keeping web URLs and unsafe schemes out of file navigation. */
export function parseFileLink(value: string): FileLocation | undefined {
	const hash = value.indexOf("#");
	const destination = hash < 0 ? value : value.slice(0, hash);
	if (destination.includes("?") || destination.startsWith("//")) return undefined;
	let path: string;
	try { path = decodeURIComponent(destination); }
	catch { return undefined; }
	if (!path || path.startsWith("//") || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
	const suffix = hash < 0 ? /:(\d+)(?::\d+|-(\d+))?$/.exec(destination) : null;
	const explicit = /^(?:[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(path);
	if (!explicit && URL.canParse(destination)) {
		const filename = suffix === null ? "" : destination.slice(0, -suffix[0].length);
		if (!/^[^:]*[./\\][^:]*$/.test(filename)) return undefined;
	}
	if (suffix !== null) path = path.slice(0, -suffix[0].length);
	if (!path) return undefined;
	const location = suffix ?? (hash < 0 ? null : /^L(\d+)(?:-L(\d+))?$/.exec(value.slice(hash + 1)));
	if (location === null) return { path };
	const line = Number(location[1]), end = location[2] === undefined ? line : Number(location[2]);
	return Number.isSafeInteger(line) && Number.isSafeInteger(end) && line >= 1 && end >= line ? { path, line } : { path };
}
