import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryCredentialStore } from "@amazme/ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { allowNetwork } from "./test-network-env.ts";

// A local fixture for pi.dev's public catalog negotiation, verified against
// Pi scripts/model-catalog-protocol.ts (1cedd3272).
// The current client consumes typed shards and identifies its version before
// receiving a catalog. This fixture owns no production server implementation.

const mixedApiRevision = `sha256-${"b".repeat(64)}`;
const modelId = "anthropic/claude-sonnet-5";
// Newer than the bundled catalog, so the client applies the remote overlay.
const lastModified = new Date("2099-01-01T00:00:00Z").toUTCString();
const commonModel = {
	id: modelId,
	name: "Claude Sonnet 5",
	provider: "openrouter",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};
const mixedApiModel = {
	...commonModel,
	api: "anthropic-messages",
	baseUrl: "https://openrouter.ai/api",
};

/** Minimal stand-in for pi.dev's /api/models/providers/:provider route. */
function startCatalogServer(requests: string[]): Promise<Server> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
		requests.push(`${url.pathname}${url.search}`);
		const provider = /^\/api\/models\/providers\/([^/]+)$/.exec(url.pathname)?.[1];
		const version = url.searchParams.get("pi-version");
		const userAgentVersion = /^pi\/([^\s()]+)/i.exec(request.headers["user-agent"] ?? "")?.[1];
		if (provider !== "openrouter") {
			response.writeHead(404).end();
		} else if (version === null && userAgentVersion) {
			url.searchParams.set("pi-version", userAgentVersion);
			response.writeHead(307, { location: url.href, "cache-control": "no-store" }).end();
		} else if (version !== VERSION || url.searchParams.get("types") !== "chat,image,classifier") {
			response.writeHead(400).end("Invalid catalog negotiation");
		} else {
			response
				.writeHead(200, {
					"content-type": "application/json",
					"last-modified": lastModified,
					"x-pi-model-catalog-revision": mixedApiRevision,
				})
				.end(JSON.stringify([{ type: "chat", ...mixedApiModel }]));
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

describe("model catalog protocol with the current client", () => {
	const requests: string[] = [];
	let server: Server;
	let catalogBaseUrl: string;

	beforeAll(async () => {
		server = await startCatalogServer(requests);
		catalogBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	it("negotiates the catalog for its version and reaches the OpenRouter API", async () => {
		allowNetwork();
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			catalogBaseUrl,
			refreshOnCreate: false,
		});
		await runtime.setRuntimeApiKey("openrouter", "test-key");
		const refresh = await runtime.refresh({
			allowNetwork: true,
			force: true,
			providers: ["openrouter"],
		});
		expect([...refresh.errors]).toEqual([]);

		const catalogUrl = "/api/models/providers/openrouter?types=chat%2Cimage%2Cclassifier";
		expect(requests).toEqual([catalogUrl, `${catalogUrl}&pi-version=${VERSION}`]);

		const model = runtime.getModel("openrouter", modelId);
		expect(model).toMatchObject({
			api: mixedApiModel.api,
			baseUrl: mixedApiModel.baseUrl,
		});
		if (!model) throw new Error(`Missing model: openrouter/${modelId}`);

		let providerUrl: URL | undefined;
		const nativeFetch = globalThis.fetch;
		vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const request = new Request(input, init);
			if (new URL(request.url).origin !== "https://openrouter.ai") return nativeFetch(request);
			providerUrl = new URL(request.url);
			throw new Error("Provider request captured");
		});
		try {
			await runtime.completeSimple(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
				{ apiKey: "test-key", maxRetries: 0 },
			);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(providerUrl?.pathname).toBe("/api/v1/messages");
	});
});
