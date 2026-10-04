import { createAssistantEventStream, type ProviderStreams } from "../models.ts";
import type { AzureOpenAIResponsesOptions, Model, OpenAIResponsesOptions } from "../types.ts";
import { openAIResponsesApi, pumpResponses } from "./openai-responses.ts";

export const AZURE_OPENAI_RESPONSES_API = "azure-openai-responses";

/** Satisfies the shared prepare step when the deployment URL is built from env. */
const AZURE_BASE_PLACEHOLDER = "https://azure.invalid";

/**
 * Azure uses its own module and Pi's `azure-openai-responses` api id.
 * The event parser is the OpenAI responses one; there is no second stream entry.
 */
export function azureOpenAIResponsesApi(options: { fetch?: typeof fetch } = {}): ProviderStreams<"azure-openai-responses"> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const streams: ProviderStreams<"azure-openai-responses"> = {
    stream(model, context, request) {
      const stream = createAssistantEventStream();
      const next = request?.baseUrl ? request : { ...request, baseUrl: AZURE_BASE_PLACEHOLDER };
      void pumpResponses(fetchImpl, model, context, next, stream, azureUrl, azureHeaders, azureDeployment);
      return stream;
    },
    streamSimple(model, context, request) {
      return streams.stream(model, context, request);
    },
  };
  return streams;
}

export function azureUrl(model: Model, request: OpenAIResponsesOptions): string {
  const azure = request as AzureOpenAIResponsesOptions;
  const resource = azure.azureResourceName || request.env?.AZURE_OPENAI_RESOURCE_NAME;
  const explicit = request.baseUrl && request.baseUrl !== AZURE_BASE_PLACEHOLDER ? request.baseUrl : undefined;
  const configured = azure.azureBaseUrl || explicit || request.env?.AZURE_OPENAI_BASE_URL || model.baseUrl;
  const root = configured || (resource ? `https://${resource}.openai.azure.com` : undefined);
  if (!root) throw new Error("Azure responses request requires an endpoint or resource name");
  let url: URL;
  try {
    url = new URL(root);
  } catch {
    throw new Error("Azure responses endpoint must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Azure responses endpoint must be an absolute HTTP(S) URL");
  }
  const version = azure.azureApiVersion || request.env?.AZURE_OPENAI_API_VERSION || url.searchParams.get("api-version") || "v1";
  const base = url.pathname.replace(/\/+$/, "").replace(/\/responses$/, "").replace(/\/openai(?:\/v1)?$/, "");
  // Azure v1 routes Responses at /openai/v1 with the deployment in the model field.
  // Explicit dated API versions use /openai/responses, as in the Azure OpenAI SDK.
  url.pathname = `${base}/openai${version === "v1" || version === "preview" ? "/v1" : ""}/responses`;
  if (version === "v1") url.searchParams.delete("api-version");
  else url.searchParams.set("api-version", version);
  url.hash = "";
  return url.toString();
}

function azureDeployment(model: Model, request: OpenAIResponsesOptions): string {
  return (request as AzureOpenAIResponsesOptions).azureDeploymentName || request.env?.AZURE_OPENAI_DEPLOYMENT_NAME || model.id;
}

function azureHeaders(request: OpenAIResponsesOptions): Record<string, string> {
  return { "api-key": request.apiKey ?? "" };
}

/** Re-export so callers can see Azure and OpenAI share one responses implementation. */
export { openAIResponsesApi };
