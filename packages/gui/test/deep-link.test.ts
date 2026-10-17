import { describe, expect, test } from "vitest";
import { withSessionDeepLink } from "../src/deep-link.ts";

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
