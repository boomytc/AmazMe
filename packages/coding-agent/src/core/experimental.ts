export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.AMAZME_EXPERIMENTAL === "1";
}
