import type { ProviderHeaders } from "@amazme/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { mergeProviderAttributionHeaders } from "../src/core/provider-attribution.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

afterEach(() => vi.unstubAllEnvs());

describe("provider attribution on actual model requests", () => {
	async function fixture(baseUrl: string, settings = SettingsManager.inMemory({ enableInstallTelemetry: true })) {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			settingsManager: settings,
		});
		let captured: ProviderHeaders | undefined;
		const requests: Array<ProviderHeaders | undefined> = [];
		runtime.registerProvider("fixture", {
			baseUrl,
			apiKey: "fixture-key",
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				captured = options?.headers;
				requests.push(captured);
				throw new Error("captured locally");
			},
			models: [
				{
					id: "plain",
					name: "Plain",
					reasoning: false,
					input: ["text"],
					contextWindow: 10000,
					maxTokens: 1000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		const model = runtime.getModel("fixture", "plain")!;
		return { runtime, model, settings, requests, headers: () => captured };
	}

	it("keeps concurrent sessions' telemetry choices independent on a shared runtime", async () => {
		const f = await fixture("https://openrouter.ai/api/v1");
		const enabledSettings = SettingsManager.inMemory({ enableInstallTelemetry: true });
		const enabled = f.runtime.withRequestSettings(enabledSettings);
		const disabled = f.runtime.withRequestSettings(SettingsManager.inMemory({ enableInstallTelemetry: false }));
		await Promise.all([
			enabled.completeSimple(f.model, { messages: [] }, { headers: { "x-owner": "enabled" } }),
			disabled.completeSimple(f.model, { messages: [] }, { headers: { "x-owner": "disabled" } }),
		]);
		expect(f.requests.find((headers) => headers?.["x-owner"] === "enabled")).toHaveProperty(
			"X-OpenRouter-Title",
			"AmazMe",
		);
		expect(f.requests.find((headers) => headers?.["x-owner"] === "disabled")).toEqual({ "x-owner": "disabled" });
		enabledSettings.setEnableInstallTelemetry(false);
		await enabled.completeSimple(f.model, { messages: [] });
		expect(f.headers()).toBeUndefined();
	});

	it.each([
		[
			"https://openrouter.ai/api/v1",
			{ "HTTP-Referer": "https://pi.dev", "X-OpenRouter-Title": "AmazMe", "X-OpenRouter-Categories": "cli-agent" },
		],
		["https://integrate.api.nvidia.com/v1", { "X-BILLING-INVOKE-ORIGIN": "AmazMe" }],
		["https://api.cloudflare.com/client/v4", { "User-Agent": "amazme-coding-agent" }],
		["https://gateway.ai.cloudflare.com/v1/test", { "User-Agent": "amazme-coding-agent" }],
	])("sends attribution to %s", async (baseUrl, expected) => {
		const f = await fixture(baseUrl);
		await f.runtime.completeSimple(f.model, { messages: [] });
		expect(f.headers()).toEqual(expected);
	});

	it("honors live settings and environment opt-out while preserving explicit headers", async () => {
		const f = await fixture("https://openrouter.ai/api/v1");
		f.settings.setEnableInstallTelemetry(false);
		await f.runtime.completeSimple(f.model, { messages: [] });
		expect(f.headers()).toBeUndefined();
		vi.stubEnv("AMAZME_TELEMETRY", "1");
		await f.runtime.completeSimple(f.model, { messages: [] });
		expect(f.headers()).toHaveProperty("X-OpenRouter-Title", "AmazMe");
		vi.stubEnv("AMAZME_TELEMETRY", "0");
		f.settings.setEnableInstallTelemetry(true);
		await f.runtime.completeSimple(f.model, { messages: [] }, { headers: { "X-OpenRouter-Title": "custom" } });
		expect(f.headers()).toEqual({ "X-OpenRouter-Title": "custom" });
	});

	it("assembles defaults before the transform and preserves case-insensitive overrides and null", async () => {
		const f = await fixture("https://openrouter.ai/api/v1");
		let transformed = false;
		await f.runtime.completeSimple(
			f.model,
			{ messages: [] },
			{
				headers: { "http-referer": null, "x-openrouter-title": "custom" },
				transformHeaders: (headers) => {
					transformed = true;
					expect(headers).toEqual({
						"http-referer": null,
						"x-openrouter-title": "custom",
						"X-OpenRouter-Categories": "cli-agent",
					});
					return { ...headers, "x-final": "yes" };
				},
			},
		);
		expect(transformed).toBe(true);
		expect(f.headers()).toHaveProperty("x-final", "yes");
	});

	it("keeps OpenCode session routing independent of telemetry", async () => {
		const f = await fixture("https://opencode.ai/zen/v1", SettingsManager.inMemory({ enableInstallTelemetry: false }));
		await f.runtime.completeSimple(f.model, { messages: [] }, { sessionId: "session-1" });
		expect(f.headers()).toEqual({ "x-opencode-session": "session-1", "x-opencode-client": "AmazMe" });
	});

	it("does not match provider host names embedded in paths or unrelated hosts", () => {
		const settings = SettingsManager.inMemory();
		for (const baseUrl of ["https://example.test/openrouter.ai", "https://openrouter.ai.example.test/v1"]) {
			expect(mergeProviderAttributionHeaders({ provider: "custom", baseUrl }, settings, undefined)).toBeUndefined();
		}
	});
});
