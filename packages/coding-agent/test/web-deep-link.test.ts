import { describe, expect, test } from "vitest";
import { sessionDeepLink } from "../src/host/web/deep-link.ts";

describe("sessionDeepLink", () => {
	test("reads session and project parameters", () => {
		expect(sessionDeepLink("http://127.0.0.1:5000/?session=abc")).toEqual({ sessionId: "abc" });
		expect(sessionDeepLink("http://127.0.0.1:5000/?project=p1&session=abc")).toEqual({
			sessionId: "abc",
			projectId: "p1",
		});
		expect(sessionDeepLink("/?session=%20abc%20", "http://127.0.0.1:5000/")).toEqual({ sessionId: "abc" });
	});

	test("ignores empty, unrelated, and malformed links", () => {
		expect(sessionDeepLink("http://127.0.0.1:5000/")).toBeUndefined();
		expect(sessionDeepLink("/?session=", "http://127.0.0.1:5000/")).toBeUndefined();
		expect(sessionDeepLink("/?session=%20%20", "http://127.0.0.1:5000/")).toBeUndefined();
		expect(sessionDeepLink("/?other=1", "http://127.0.0.1:5000/")).toBeUndefined();
		expect(sessionDeepLink("http://[bad")).toBeUndefined();
	});
});
