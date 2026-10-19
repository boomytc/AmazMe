import type { AnyModel, ProviderHeaders } from "@amazme/ai";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";
type AttributionModel = Pick<AnyModel, "provider" | "baseUrl">;

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

function isOpenRouterModel(model: AttributionModel): boolean {
	return model.provider === "openrouter" || matchesHost(model.baseUrl, OPENROUTER_HOST);
}

function isNvidiaNimModel(model: AttributionModel): boolean {
	return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

function isCloudflareModel(model: AttributionModel): boolean {
	return (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
		matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
	);
}

function getDefaultAttributionHeaders(
	model: AttributionModel,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (isOpenRouterModel(model)) {
		return {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "AmazMe",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (isNvidiaNimModel(model)) {
		return {
			"X-BILLING-INVOKE-ORIGIN": "AmazMe",
		};
	}

	if (isCloudflareModel(model)) {
		return {
			"User-Agent": "amazme-coding-agent",
		};
	}

	return undefined;
}

function getSessionHeaders(model: AttributionModel, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!matchesHost(model.baseUrl, OPENCODE_HOST)
	) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": "AmazMe" };
}

export function mergeProviderAttributionHeaders(
	model: AttributionModel,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {
		...getSessionHeaders(model, sessionId),
		...getDefaultAttributionHeaders(model, settingsManager),
	};

	for (const headers of headerSources) {
		if (headers) {
			for (const [name, value] of Object.entries(headers)) {
				for (const existing of Object.keys(merged)) {
					if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
				}
				merged[name] = value;
			}
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
