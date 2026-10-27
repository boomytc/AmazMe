export const UPSTREAM_RELEASES = [
	{
		version: "0.38.0",
		repository: "trycua/cua",
		tag: "cua-driver-rs-v0.38.0",
		assets: {
			darwin: {
				name: "cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz",
				sha256:
					"2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732",
			},
			"linux-x64": {
				name: "cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz",
				sha256:
					"31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd",
			},
			"linux-arm64": {
				name: "cua-driver-rs-0.38.0-linux-arm64-binary.tar.gz",
				sha256:
					"80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d",
			},
			"win32-x64": {
				name: "cua-driver-rs-0.38.0-windows-x86_64-binary.zip",
				sha256:
					"5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5",
			},
			"win32-arm64": {
				name: "cua-driver-rs-0.38.0-windows-arm64-binary.zip",
				sha256:
					"d25c8ebfffb34e4c095ea170baf47b87c35dc0d1116f42e46b39df2bcbff8700",
			},
		},
	},
] as const;

// Building a pinned recipe does not promote it; only the explicit default is discovered.
export const PATCH_BUILDS = [
	{
		pin: {
			version: "0.38.0-amazme.2",
			sourceCommit: "85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19",
			patchSha256:
				"7b00cf51a49ec367ff1b2d92eaf40ecdd376a762fca2699d74471ff1d0a8d91d",
		},
		upstreamVersion: "0.38.0",
		bundleBuild: "4",
		patchFile: "cua-driver-0.38.0-background.patch",
	},
] as const;

export const DEFAULT_PATCH_VERSION = "0.38.0-amazme.2";

export function patchBuild(version: string) {
	const build = PATCH_BUILDS.find((build) => build.pin.version === version);
	if (!build) throw new Error(`Unsupported patched runtime: ${version}`);
	return build;
}

export const PATCH_PIN = patchBuild(DEFAULT_PATCH_VERSION).pin;
export const BUNDLE_BUILD = patchBuild(DEFAULT_PATCH_VERSION).bundleBuild;

export function upstreamRelease(version: string) {
	const release = UPSTREAM_RELEASES.find(
		(release) => release.version === version,
	);
	if (!release) throw new Error(`Unsupported upstream runtime: ${version}`);
	return release;
}
export const DRIVER_PIN = upstreamRelease(
	patchBuild(DEFAULT_PATCH_VERSION).upstreamVersion,
);
