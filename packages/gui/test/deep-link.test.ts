import { describe, expect, test } from "vitest";
import { withSessionDeepLink, withWindowTarget } from "../src/deep-link.ts";

describe("withSessionDeepLink", () => {
	test("adds the session to a host URL", () => {
		expect(withSessionDeepLink("http://127.0.0.1:5000/", "abc")).toBe("http://127.0.0.1:5000/?session=abc");
		expect(withSessionDeepLink("http://127.0.0.1:5000/?a=1", "a b")).toBe(
			"http://127.0.0.1:5000/?a=1&session=a+b",
		);
	});

	test("leaves the URL alone without a session or with a bad one", () => {
		expect(withSessionDeepLink("http://127.0.0.1:5000/", undefined)).toBe("http://127.0.0.1:5000/");
		expect(withSessionDeepLink("http://127.0.0.1:5000/", "  ")).toBe("http://127.0.0.1:5000/");
		expect(withSessionDeepLink("not a url", "abc")).toBe("not a url");
	});
});

describe("withWindowTarget", () => {
	test("names a new window by workspace instead of an existing session", () => {
		expect(withWindowTarget("http://127.0.0.1:5000/", { workspace: "primary", fresh: true })).toBe(
			"http://127.0.0.1:5000/?workspace=primary&new=1",
		);
		expect(withWindowTarget("http://127.0.0.1:5000/", { sessionId: "abc", workspace: "primary" })).toBe(
			"http://127.0.0.1:5000/?session=abc&workspace=primary",
		);
	});

	test("leaves a bare host URL and a bad URL unchanged", () => {
		expect(withWindowTarget("http://127.0.0.1:5000/")).toBe("http://127.0.0.1:5000/");
		expect(withWindowTarget("not a url", { workspace: "primary", fresh: true })).toBe("not a url");
	});
});
