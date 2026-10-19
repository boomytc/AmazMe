export interface ReleaseManifest {
	version: string;
	tag: string;
	assets: { name: string; url: string; sha256: string }[];
}

export function buildManifest(input: {
	tag: string;
	repository: string;
	installers: { name: string; digest: string; published: string }[];
}): ReleaseManifest;
