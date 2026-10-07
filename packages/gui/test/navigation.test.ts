import { describe, expect, test } from "vitest";
import { hasOrigin, isAllowedNavigation, isExternalUrl } from "../src/navigation.ts";

const origin = "http://127.0.0.1:4310";

describe("window navigation", () => {
	test("stays on the host origin and lets Electron open its blank document", () => {
		expect(hasOrigin("http://127.0.0.1:4310/tokens.css", origin)).toBe(true);
		expect(hasOrigin("http://127.0.0.1:9/", origin)).toBe(false);
		expect(isAllowedNavigation("about:blank", origin)).toBe(true);
		expect(isAllowedNavigation("https://example.com", origin)).toBe(false);
	});

	test("hands only http(s) links to the system browser", () => {
		expect(isExternalUrl("https://example.com/docs")).toBe(true);
		expect(isExternalUrl("http://127.0.0.1:4310/")).toBe(true);
		expect(isExternalUrl("file:///etc/passwd")).toBe(false);
		expect(isExternalUrl("javascript:alert(1)")).toBe(false);
		expect(isExternalUrl("not a url")).toBe(false);
	});
});
