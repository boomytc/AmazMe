import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@amazme/coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createAcmeServer,
	STREAM_MODEL_ID,
	STREAM_PROBE_PROMPT,
	STREAM_PROBE_RESPONSE,
	STREAM_PROVIDER_ID,
} from "../evals/acme-server.ts";
import {
	inspectConfiguredProvider,
	inspectProvider,
	loadConfiguredModelRuntime,
} from "../evals/configured-runtime.ts";
import type { ProviderScenario } from "../evals/configured-runtime.ts";
import type { AcmeStreamFixtureConfig } from "./fixtures/acme-stream-extension.ts";

const server = createAcmeServer("stream");
const directories: string[] = [];
const apiSymbol = Symbol.for("amazme.evals.acme-stream.api");
const expected = {
	result: {
		validRequestReceived: true,
		model: {
			id: STREAM_MODEL_ID,
			name: "Acme Stream Chat",
			provider: STREAM_PROVIDER_ID,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16384,
			maxTokens: 2048,
		},
		response: { text: STREAM_PROBE_RESPONSE, stopReason: "stop", inputTokens: 4, outputTokens: 3 },
	},
};

beforeAll(() => server.start());
beforeEach(() => server.reset());
afterEach(async () => {
	vi.unstubAllEnvs();
	Reflect.deleteProperty(globalThis, apiSymbol);
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
afterAll(() => server.stop());

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "amazme-eval-stream-provider-"));
	directories.push(directory);
	return directory;
}

async function agentWithExtension(registration: AcmeStreamFixtureConfig["registration"]): Promise<string> {
	const directory = await temporaryDirectory();
	const extensions = join(directory, "extensions");
	await mkdir(extensions);
	await copyFile(new URL("./fixtures/acme-stream-extension.ts", import.meta.url), join(extensions, "acme-stream.ts"));
	const config: AcmeStreamFixtureConfig = { baseUrl: server.origin(), registration };
	await writeFile(join(extensions, "acme-stream-config.json"), JSON.stringify(config));
	return directory;
}

function probe(apiKey = "resolved-stream-key"): ProviderScenario {
	return {
		providerId: STREAM_PROVIDER_ID,
		modelId: STREAM_MODEL_ID,
		createContext: () => ({ messages: [{ role: "user", content: STREAM_PROBE_PROMPT, timestamp: 0 }] }),
		options: { env: { ACME_STREAM_API_KEY: apiKey }, maxTokens: 32 },
		validRequestReceived: server.validRequestReceived,
	};
}

function expectInvalidated(): void {
	const api = Reflect.get(globalThis, apiSymbol) as ExtensionAPI | undefined;
	expect(api).toBeDefined();
	expect(() => api!.getFlag("acme-stream-fixture")).toThrow("stale");
}

describe("inspectConfiguredProvider", () => {
	it.each(["legacy", "native"] as const)("probes a real %s extension through the Acme NDJSON server", async (kind) => {
		const directory = await agentWithExtension(kind);
		// The former docs-eval path cannot discover this extension or make its request.
		await expect(inspectProvider(await loadConfiguredModelRuntime(directory), probe())).resolves.toEqual({
			result: { error: `Model ${STREAM_PROVIDER_ID}/${STREAM_MODEL_ID} is unavailable after reload.` },
		});
		expect(server.validRequestReceived()).toBe(false);
		expect(Reflect.has(globalThis, apiSymbol)).toBe(false);

		await expect(inspectConfiguredProvider(directory, probe())).resolves.toEqual(expected);
		expectInvalidated();
	});

	it("reports extension load errors and invalidates successfully loaded extensions", async () => {
		const directory = await agentWithExtension("legacy");
		await writeFile(join(directory, "extensions", "broken.ts"), 'export default () => { throw new Error("fixture load failure"); };');
		const output = await inspectConfiguredProvider(directory, probe());
		expect(output).toEqual({ result: { error: expect.stringContaining("fixture load failure") } });
		expect(output).toEqual({ result: { error: expect.stringContaining("broken.ts") } });
		expect(server.validRequestReceived()).toBe(false);
		expectInvalidated();
	});

	it("reports registration errors and invalidates the extension runtime", async () => {
		const directory = await agentWithExtension("invalid");
		await expect(inspectConfiguredProvider(directory, probe())).resolves.toEqual({
			result: { error: "Provider id must not be empty." },
		});
		expect(server.validRequestReceived()).toBe(false);
		expectInvalidated();
	});

	it("invalidates the extension runtime after a failed completion", async () => {
		const directory = await agentWithExtension("legacy");
		expect(await inspectConfiguredProvider(directory, probe("wrong-key"))).toEqual({
			result: {
				...expected.result,
				validRequestReceived: false,
				response: { text: "", stopReason: "error", inputTokens: 0, outputTokens: 0 },
			},
		});
		expectInvalidated();
	});

	it("keeps extension and credential discovery inside the supplied eval directory", async () => {
		const unrelated = await temporaryDirectory();
		const extensions = join(unrelated, "extensions");
		await mkdir(extensions);
		await writeFile(join(extensions, "personal.ts"), 'export default () => { throw new Error("outside eval"); };');
		await writeFile(join(unrelated, "auth.json"), "invalid credential fixture");
		vi.stubEnv("AMAZME_CODING_AGENT_DIR", unrelated);
		const directory = await agentWithExtension("legacy");
		await expect(inspectConfiguredProvider(directory, probe())).resolves.toEqual(expected);
		expectInvalidated();
	});
});
