export interface ReleaseManifest {
	version: string;
	tag: string;
	assets: { name: string; url: string; sha256: string; size: number; platform: "darwin"; arch: "arm64" | "x64" }[];
}

export function buildManifest(input: {
	tag: string;
	repository: string;
	installers: { name: string; digest: string; published: string; size: number }[];
}): ReleaseManifest;
