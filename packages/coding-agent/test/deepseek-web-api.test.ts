import { createServer } from "node:http";
import { once } from "node:events";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@amazme/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchResult, originalQuestion, requestWeb, searchResult } from "../plugins/web/src/api.ts";
import { DEFAULT_WEB_SETTINGS, editWebSettings, readWebSettings, webURL } from "../plugins/web/src/config.ts";

const settings = { ...DEFAULT_WEB_SETTINGS, enabled: true };
const key = async () => "fixture-key";
const identity = (value: unknown) => value;
const json = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("DeepSeek web transport", () => {
	it("uses a separate prefixed endpoint, resolves fresh credentials and never forwards chat identity", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json({ content: "page" }));
		vi.stubGlobal("fetch", fetch);
		let credential = "first";
		for (const expected of ["first", "second"]) {
			credential = expected;
			await requestWeb(
				{ ...settings, baseURL: "https://gateway.test/prefix/tools" },
				"fetch",
				{ url: "https://page.test/" },
				async () => credential,
				identity,
				context,
			);
			const [url, init] = fetch.mock.lastCall!;
			expect(url).toBe("https://gateway.test/prefix/tools/fetch");
			expect(init).toMatchObject({
				method: "POST",
				redirect: "error",
				body: '{"url":"https://page.test/"}',
			});
			expect(init?.headers).toEqual({
				authorization: `Bearer ${expected}`,
				"content-type": "application/json",
				accept: "application/json",
			});
		}
	});

	it("rejects disabled, pre-cancelled and missing-key calls before network side effects", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetch);
		const resolve = vi.fn(key);
		await expect(requestWeb(DEFAULT_WEB_SETTINGS, "search", {}, resolve, identity, context)).rejects.toThrow(
			"disabled",
		);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			requestWeb(settings, "search", {}, resolve, identity, withAbortSignal(controller.signal, context)),
		).rejects.toThrow("cancelled");
		expect(resolve).not.toHaveBeenCalled();
		await expect(requestWeb(settings, "search", {}, async () => undefined, identity, context)).rejects.toThrow(
			"API key",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("bounds uncooperative credential resolution and observes a late rejection", async () => {
		let fail!: (error: Error) => void;
		const resolve = vi.fn(
			() =>
				new Promise<string>((_resolve, reject) => {
					fail = reject;
				}),
		);
		const fetch = vi.fn<typeof globalThis.fetch>();
		vi.stubGlobal("fetch", fetch);
		const controller = new AbortController();
		const result = requestWeb(settings, "search", {}, resolve, identity, withAbortSignal(controller.signal, context));
		controller.abort(new Error("stop"));
		await expect(result).rejects.toThrow("stop");
		fail(new Error("late private credential failure"));
		await new Promise((resolve) => setImmediate(resolve));
		expect(fetch).not.toHaveBeenCalled();
	});

	it("cancels the body of a response arriving after an uncooperative fetch was abandoned", async () => {
		let deliver!: (response: Response) => void;
		const fetch = vi.fn<typeof globalThis.fetch>(
			() =>
				new Promise((resolve) => {
					deliver = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const controller = new AbortController();
		const result = requestWeb(settings, "fetch", {}, key, identity, withAbortSignal(controller.signal, context));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		controller.abort(new Error("stop"));
		await expect(result).rejects.toThrow("stop");
		const cancel = vi.fn();
		deliver(new Response(new ReadableStream({ cancel })));
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
	});

	it.each(["credentials", "headers", "body"] as const)("applies the timeout while waiting for %s", async (stage) => {
		const cancel = vi.fn();
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockImplementation(() =>
				stage === "headers"
					? new Promise<Response>(() => {})
					: Promise.resolve(new Response(new ReadableStream({ cancel }))),
			);
		vi.stubGlobal("fetch", fetch);
		await expect(
			requestWeb(
				{ ...settings, timeoutMs: 20 },
				"search",
				{},
				stage === "credentials" ? () => new Promise<string>(() => {}) : key,
				identity,
				context,
			),
		).rejects.toThrow("timed out");
		if (stage === "credentials") expect(fetch).not.toHaveBeenCalled();
		if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
	});

	it.each([true, false])("limits response bytes with and without Content-Length (%s)", async (header) => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof globalThis.fetch>().mockResolvedValue(
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("12345"));
						},
						cancel,
					}),
					{ headers: header ? { "content-length": "5" } : {} },
				),
			),
		);
		await expect(
			requestWeb({ ...settings, maxResponseBytes: 4 }, "search", {}, key, identity, context),
		).rejects.toThrow("maxResponseBytes");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("sanitizes remote, JSON and credential errors without retaining secret causes", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("private-api-key", { status: 401 }));
		vi.stubGlobal("fetch", fetch);
		await expect(requestWeb(settings, "search", {}, key, identity, context)).rejects.toThrow("HTTP 401");
		fetch.mockResolvedValue(new Response("private-json"));
		await expect(requestWeb(settings, "search", {}, key, identity, context)).rejects.toThrow("not valid JSON");
		const error: unknown = await requestWeb(
			settings,
			"search",
			{},
			async () => {
				throw new Error("DeepSeek private-api-key");
			},
			identity,
			context,
		).catch((error) => error);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain("private-api-key");
		expect(error).not.toHaveProperty("cause");
	});

	it.each([301, 302, 303, 307, 308])(
		"does not follow a real HTTP %s redirect or send its credentials/body to the target",
		async (status) => {
			let targetCalls = 0;
			const server = createServer((request, response) => {
				if (request.url === "/target") {
					targetCalls++;
					response.end("{}");
				} else {
					response.writeHead(status, { location: "/target" });
					response.end();
				}
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			try {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Missing listener");
				await expect(
					requestWeb(
						{ ...settings, baseURL: `http://127.0.0.1:${address.port}` },
						"search",
						{ query: "private-question" },
						key,
						identity,
						context,
					),
				).rejects.toThrow("request failed");
				expect(targetCalls).toBe(0);
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
	);
});

describe("DeepSeek web contracts", () => {
	it("preserves source order, nullable metadata and empty successful search results", () => {
		expect(
			searchResult(
				{
					results: [
						{
							url: "https://b.test/",
							title: "B",
							snippet: "brief",
							date: null,
							summary: "ignored",
						},
						{
							url: "https://a.test/",
							title: "",
							snippet: "",
							date: "2026-10-19",
						},
					],
				},
				10,
				1000,
			),
		).toEqual({
			provider: "deepseek-search-api",
			truncated: false,
			sources: [
				{ url: "https://b.test/", title: "B", snippet: "brief" },
				{ url: "https://a.test/", publishedAt: "2026-10-19" },
			],
		});
		expect(searchResult({ results: [] }, 10, 100)).toMatchObject({
			sources: [],
			truncated: false,
		});
	});

	it("bounds both structured and text output without splitting emoji or inventing fetch status", () => {
		const result = fetchResult({ content: "a😀b", title: "title" }, "https://page.test", 2);
		expect(result).toEqual({
			provider: "deepseek-fetch-api",
			url: "https://page.test",
			title: "t",
			content: "a",
			truncated: true,
		});
		expect(result).not.toHaveProperty("statusCode");
		const source = {
			url: "https://a.test/",
			title: "😀",
			snippet: "excerpt",
			date: null,
		};
		expect(searchResult({ results: [source, source] }, 1, source.url.length + 1)).toMatchObject({
			sources: [{ url: source.url, snippet: "e" }],
			truncated: true,
		});
		expect(() => searchResult({ results: [{ ...source, url: "file:///etc/passwd" }] }, 10, 1000)).toThrow();
		expect(() => fetchResult({ content: 42 }, "https://page.test", 100)).toThrow("Invalid");
	});

	it("trims original questions to 128 Unicode characters and collapses whitespace", () => {
		expect(originalQuestion("  a\n\t b  ")).toBe("a b");
		expect(Array.from(originalQuestion("😀".repeat(129))!)).toHaveLength(128);
		expect(originalQuestion(" \n ")).toBeUndefined();
	});

	it.each([
		{ baseURL: "https://user:key@host.test" },
		{ baseURL: "file:///etc" },
		{ baseURL: "https://host.test/?key=secret" },
		{ baseURL: "https://host.test/#hash" },
		{ count: 51 },
		{ count: 1.5 },
		{ timeoutMs: 0 },
		{ maxContentChars: -1 },
		{ maxResponseBytes: 17 * 1024 * 1024 },
		{ sendOriginalQuestion: "false" },
		{ apiKey: "secret" },
	])("rejects invalid user configuration %j before storing it", (patch) => {
		expect(() => editWebSettings({ ...DEFAULT_WEB_SETTINGS }, JSON.stringify(patch))).toThrow();
		expect(DEFAULT_WEB_SETTINGS.enabled).toBe(false);
	});

	it("normalizes only explicit user API bases and rejects non-HTTP fetch targets", () => {
		expect(
			readWebSettings({
				...settings,
				baseURL: "https://gateway.test/prefix///",
			}).baseURL,
		).toBe("https://gateway.test/prefix");
		expect(editWebSettings({ ...settings }, "off").enabled).toBe(false);
		for (const url of ["ftp://page.test", "https://user:pass@page.test", "javascript:alert(1)"])
			expect(() => webURL(url)).toThrow();
	});
});
