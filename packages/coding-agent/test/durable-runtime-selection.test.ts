import { describe, expect, it } from "vitest";
import { selectHeadlessRuntime, type HeadlessRuntimeSelection } from "../src/durable/runtime-selection.ts";

const base: HeadlessRuntimeSelection = {
	appMode: "print",
	metadataOnly: false,
	explicit: undefined,
	jsonlSessionFlags: false,
	inlineFactories: false,
	continuing: false,
	hasDurableSession: false,
};

describe("headless runtime selection", () => {
	it("defaults new headless runs to Durable", () => {
		expect(selectHeadlessRuntime(base)).toBe("durable");
	});

	it("keeps metadata and interactive runs out of the headless branch", () => {
		expect(selectHeadlessRuntime({ ...base, metadataOnly: true })).toBe("legacy");
		expect(selectHeadlessRuntime({ ...base, appMode: "interactive" })).toBe("legacy");
	});

	it("falls back to JSONL for JSONL-only selection and SDK factories", () => {
		expect(selectHeadlessRuntime({ ...base, jsonlSessionFlags: true })).toBe("legacy");
		expect(selectHeadlessRuntime({ ...base, inlineFactories: true })).toBe("legacy");
	});

	it("continues Durable only when the project already has a Durable session", () => {
		expect(selectHeadlessRuntime({ ...base, continuing: true, hasDurableSession: false })).toBe("legacy");
		expect(selectHeadlessRuntime({ ...base, continuing: true, hasDurableSession: true })).toBe("durable");
	});

	it("honors explicit selection, including a later clear rejection", () => {
		expect(selectHeadlessRuntime({ ...base, explicit: "legacy" })).toBe("legacy");
		expect(selectHeadlessRuntime({ ...base, explicit: "durable", jsonlSessionFlags: true })).toBe("durable");
	});
});
