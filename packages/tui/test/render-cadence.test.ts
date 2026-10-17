import assert from "node:assert";
import { describe, it } from "node:test";
import { clampRenderIntervalMs, resolveRenderIntervalMs } from "../src/index.ts";

describe("render cadence", () => {
	it("clamps requested frame intervals", () => {
		assert.strictEqual(clampRenderIntervalMs(16), 16);
		assert.strictEqual(clampRenderIntervalMs(-5), 0);
		assert.strictEqual(clampRenderIntervalMs(500), 100);
		assert.strictEqual(clampRenderIntervalMs(Number.NaN), 16);
		assert.strictEqual(clampRenderIntervalMs(8.6), 9);
	});

	it("reads the environment override and falls back to the default", () => {
		assert.strictEqual(resolveRenderIntervalMs({}), 16);
		assert.strictEqual(resolveRenderIntervalMs({ AMAZME_RENDER_INTERVAL_MS: "33" }), 33);
		assert.strictEqual(resolveRenderIntervalMs({ AMAZME_RENDER_INTERVAL_MS: "999" }), 100);
		assert.strictEqual(resolveRenderIntervalMs({ AMAZME_RENDER_INTERVAL_MS: "nope" }), 16);
	});
});
