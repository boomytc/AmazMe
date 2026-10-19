import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream, createProvider } from "@amazme/ai";
import type { AssistantMessage, Model, ProviderStreams } from "@amazme/ai";
import type { ExtensionAPI } from "@amazme/coding-agent";

export type AcmeStreamFixtureConfig = {
	baseUrl: string;
	registration: "legacy" | "native" | "invalid";
};

export default function acmeStreamExtension(pi: ExtensionAPI): void {
	const config: AcmeStreamFixtureConfig = JSON.parse(
		readFileSync(new URL("./acme-stream-config.json", import.meta.url), "utf8"),
	);
	Reflect.set(globalThis, Symbol.for("amazme.evals.acme-stream.api"), pi);
	pi.registerFlag("acme-stream-fixture", { type: "boolean", default: true });
	const model: Model<"acme-stream-api"> = {
		id: "acme-stream-chat",
		name: "Acme Stream Chat",
		api: "acme-stream-api",
		provider: "acme-stream",
		baseUrl: config.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16384,
		maxTokens: 2048,
	};
	const streamSimple: ProviderStreams["streamSimple"] = (requestModel, context, options) => {
		const stream = createAssistantMessageEventStream();
		const text = { type: "text" as const, text: "" };
		const message: AssistantMessage = {
			role: "assistant",
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			content: [text],
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		void (async () => {
			const response = await fetch(`${requestModel.baseUrl}/generate`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-acme-key": options?.apiKey ?? "" },
				body: JSON.stringify({ model: requestModel.id, messages: context.messages, stream: true }),
				signal: options?.signal,
			});
			if (!response.ok) throw new Error(`Acme Stream HTTP ${response.status}`);
			const body = await response.text();
			// Captured extension APIs must remain active until the asynchronous probe finishes.
			if (!pi.getFlag("acme-stream-fixture")) throw new Error("Missing fixture flag");
			stream.push({ type: "start", partial: message });
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			for (const line of body.trim().split("\n")) {
				const event: {
					type: string; text?: string; input_tokens?: number; output_tokens?: number; reason?: string;
				} = JSON.parse(line);
				if (event.type === "text_delta" && event.text !== undefined) {
					text.text += event.text;
					stream.push({ type: "text_delta", contentIndex: 0, delta: event.text, partial: message });
				} else if (event.type === "usage") {
					message.usage.input = event.input_tokens ?? 0;
					message.usage.output = event.output_tokens ?? 0;
					message.usage.totalTokens = message.usage.input + message.usage.output;
				} else if (event.type === "done" && event.reason === "stop") {
					stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
					stream.push({ type: "done", reason: "stop", message });
					stream.end();
					return;
				}
			}
			throw new Error("Acme Stream response has no done event");
		})().catch((error: unknown) => {
			message.stopReason = "error";
			message.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: message });
			stream.end();
		});
		return stream;
	};
	if (config.registration === "legacy") {
		pi.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			apiKey: "$ACME_STREAM_API_KEY",
			models: [model],
			streamSimple,
		});
	} else {
		pi.registerProvider(createProvider({
			id: config.registration === "invalid" ? "" : model.provider,
			models: [model],
			auth: {
				apiKey: {
					name: "Acme Stream fixture",
					resolve: async ({ ctx }) => {
						const apiKey = await ctx.env("ACME_STREAM_API_KEY");
						return apiKey ? { auth: { apiKey } } : undefined;
					},
				},
			},
			api: { stream: streamSimple, streamSimple },
		}));
	}
}
