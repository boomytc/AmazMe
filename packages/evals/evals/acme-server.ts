import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const OPENAI_PROVIDER_ID = "acme";
export const OPENAI_MODEL_ID = "acme-chat";
export const OPENAI_PROBE_PROMPT = "Reply with ACME_OK.";
export const OPENAI_PROBE_RESPONSE = "ACME_OK";
export const ANTHROPIC_PROVIDER_ID = "acme-messages";
export const ANTHROPIC_MODEL_ID = "acme-messages-chat";
export const ANTHROPIC_PROBE_PROMPT = "Reply with ACME_MESSAGES_OK.";
export const ANTHROPIC_PROBE_RESPONSE = "ACME_MESSAGES_OK";
type ServerMode = "openai" | "anthropic";
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function reject(response: ServerResponse, status: number): void {
	response.writeHead(status);
	response.end();
}
async function readJson(request: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of request) {
		body += chunk.toString();
		if (body.length > 1048576) throw new Error("request_limit");
	}
	return JSON.parse(body);
}
export type AcmeServer = {
	start(): Promise<void>;
	stop(): Promise<void>;
	reset(): void;
	origin(): string;
	baseUrl(): string;
	validRequestReceived(): boolean;
};
export function createAcmeServer(mode: ServerMode): AcmeServer {
	let server: Server | undefined;
	let origin = "";
	let valid = false;
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.url !== (mode === "openai" ? "/v1/chat/completions" : "/v1/messages")) return reject(response, 404);
		if (request.method !== "POST") return reject(response, 405);
		if (!request.headers["content-type"]?.startsWith("application/json")) return reject(response, 415);
		let payload: unknown;
		try {
			payload = await readJson(request);
		} catch {
			return reject(response, 400);
		}
		if (!isRecord(payload)) return reject(response, 422);
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const user = messages.find(
			(message): message is Record<string, unknown> => isRecord(message) && message.role === "user",
		);
		const content = user?.content;
		const prompt =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter(isRecord)
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("")
					: undefined;
		const apiKey =
			mode === "openai"
				? request.headers.authorization === "Bearer resolved-acme-key"
				: request.headers["x-api-key"] === "resolved-messages-key";
		if (!apiKey) return reject(response, 401);
		if (
			payload.model !== (mode === "openai" ? OPENAI_MODEL_ID : ANTHROPIC_MODEL_ID) ||
			prompt === undefined ||
			payload.stream !== true
		)
			return reject(response, 422);
		valid ||= prompt === (mode === "openai" ? OPENAI_PROBE_PROMPT : ANTHROPIC_PROBE_PROMPT);
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const send = (data: Record<string, unknown>) => response.write(`data: ${JSON.stringify(data)}\n\n`);
		if (mode === "anthropic") {
			send({
				type: "message_start",
				message: {
					id: "msg-fixture",
					type: "message",
					role: "assistant",
					model: ANTHROPIC_MODEL_ID,
					content: [],
					usage: { input_tokens: 4, output_tokens: 0 },
				},
			});
			send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANTHROPIC_PROBE_RESPONSE } });
			send({ type: "content_block_stop", index: 0 });
			send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
			send({ type: "message_stop" });
		} else {
			send({
				id: "chatcmpl-fixture",
				object: "chat.completion.chunk",
				created: 0,
				model: OPENAI_MODEL_ID,
				choices: [{ index: 0, delta: { role: "assistant", content: OPENAI_PROBE_RESPONSE }, finish_reason: null }],
			});
			send({
				id: "chatcmpl-fixture",
				object: "chat.completion.chunk",
				created: 0,
				model: OPENAI_MODEL_ID,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 3, completion_tokens: 2 },
			});
			response.write("data: [DONE]\n\n");
		}
		response.end();
	}
	return {
		async start() {
			server = createServer((req, res) => {
				void handle(req, res).catch(() => reject(res, 500));
			});
			await new Promise<void>((accept, reject) => {
				server?.once("error", reject);
				server?.listen(0, "127.0.0.1", accept);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("fixture_bind_failed");
			origin = `http://127.0.0.1:${address.port}`;
		},
		async stop() {
			const current = server;
			if (current)
				await new Promise<void>((accept, reject) => current.close((error) => (error ? reject(error) : accept())));
			server = undefined;
		},
		reset() {
			valid = false;
		},
		origin: () => origin,
		baseUrl: () => `${origin}/v1`,
		validRequestReceived: () => valid,
	};
}
