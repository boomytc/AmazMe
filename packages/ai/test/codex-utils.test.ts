import { describe, expect, it } from "vitest";
import { codexTestModel, getCodexTestModel } from "./codex-utils.ts";

describe("Codex live test model selection", () => {
	it("uses the configured model or the current account test default", () => {
		expect(codexTestModel.id).toBe(process.env.AMAZME_CODEX_TEST_MODEL ?? "gpt-6-luna");
	});

	it("allows an explicit catalog model without changing historical fixtures", () => {
		expect(getCodexTestModel("gpt-5.5").id).toBe("gpt-5.5");
	});

	it("rejects unknown model IDs instead of falling back or skipping tests", () => {
		expect(() => getCodexTestModel("missing-model")).toThrow("Unknown Codex test model");
	});

	it("rejects models that cannot exercise image and reasoning coverage", () => {
		expect(() => getCodexTestModel("gpt-5.3-codex-spark")).toThrow("must support image input and xhigh reasoning");
	});
});
