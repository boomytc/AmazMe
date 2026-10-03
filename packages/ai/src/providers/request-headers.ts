import type { ProviderStreams } from "../models.ts";
import type { Context, Message, Model, StreamOptions } from "../types.ts";

const OPENCODE_SESSION_HEADER = "x-opencode-session";

export const COPILOT_STATIC_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/** Copilot's extra headers sit beside the request. They are not a new protocol. */
export function withCopilotHeaders(streams: ProviderStreams): ProviderStreams {
  return mapStreams(streams, (model, context, options) => ({
    model,
    options: {
      ...options,
      headers: {
        ...COPILOT_STATIC_HEADERS,
        "X-Initiator": initiator(context),
        "Openai-Intent": "conversation-edits",
        ...(hasImage(context.messages) ? { "Copilot-Vision-Request": "true" } : {}),
        ...options?.headers,
      },
    },
  }));
}

/** OpenCode copies an optional session id onto `x-opencode-session` before dispatch. */
export function withOpenCodeSessionHeader(streams: ProviderStreams): ProviderStreams {
  return mapStreams(streams, (model, _context, options) => {
    if (!options?.sessionId || hasHeader(options.headers, OPENCODE_SESSION_HEADER)) return { model, options };
    return {
      model,
      options: { ...options, headers: { ...options.headers, [OPENCODE_SESSION_HEADER]: options.sessionId } },
    };
  });
}

/** Replace Cloudflare account and gateway placeholders from resolved env. The catalog URL stays unchanged. */
export function withCloudflarePlaceholders(streams: ProviderStreams): ProviderStreams {
  return mapStreams(streams, (model, _context, options) => {
    const baseUrl = fillCloudflare(options?.baseUrl ?? model.baseUrl, options?.env);
    return {
      model: baseUrl && baseUrl !== model.baseUrl ? { ...model, baseUrl } : model,
      options: baseUrl ? { ...options, baseUrl } : options,
    };
  });
}

export function fillCloudflare(url: string | undefined, env: Record<string, string | undefined> | undefined): string | undefined {
  if (!url || !env) return url;
  return url
    .replaceAll("{CLOUDFLARE_ACCOUNT_ID}", env.CLOUDFLARE_ACCOUNT_ID ?? "{CLOUDFLARE_ACCOUNT_ID}")
    .replaceAll("{CLOUDFLARE_GATEWAY_ID}", env.CLOUDFLARE_GATEWAY_ID ?? "{CLOUDFLARE_GATEWAY_ID}");
}

function mapStreams(
  streams: ProviderStreams,
  map: (model: Model, context: Context, options: StreamOptions | undefined) => { model: Model; options: StreamOptions | undefined },
): ProviderStreams {
  return {
    stream(model, context, options) {
      const next = map(model, context, options);
      return streams.stream(next.model, context, next.options);
    },
    streamSimple(model, context, options) {
      const next = map(model, context, options);
      return streams.streamSimple(next.model, context, next.options);
    },
  };
}

function initiator(context: Context): "user" | "agent" {
  const last = context.messages[context.messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

function hasImage(messages: readonly Message[]): boolean {
  return messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.type === "image"));
}

function hasHeader(headers: StreamOptions["headers"], name: string): boolean {
  const expected = name.toLowerCase();
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}
