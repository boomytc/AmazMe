/** Apple plist versions are numeric; the signed app/package.json retains full SemVer. */
export function macOSBundleVersion(version: string): string {
	const match = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
	if (!match) throw new Error("signature");
	return match[1]!;
}
