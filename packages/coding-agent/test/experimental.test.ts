import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.AMAZME_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.AMAZME_EXPERIMENTAL;
		} else {
			process.env.AMAZME_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when AMAZME_EXPERIMENTAL is unset", () => {
		delete process.env.AMAZME_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when AMAZME_EXPERIMENTAL is empty", () => {
		process.env.AMAZME_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when AMAZME_EXPERIMENTAL is set to 1", () => {
		process.env.AMAZME_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when AMAZME_EXPERIMENTAL is set to 0", () => {
		process.env.AMAZME_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when AMAZME_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.AMAZME_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
