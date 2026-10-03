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
      void pumpResponses(fetchImpl, model, context, next, stream, azureUrl);
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
  const configured = azure.azureBaseUrl || explicit;
  const root = (configured && configured.length > 0
    ? configured
    : resource
      ? `https://${resource}.openai.azure.com`
      : "").replace(/\/$/, "");
  const deployment = azure.azureDeploymentName
    || request.env?.AZURE_OPENAI_DEPLOYMENT_NAME
    || model.id;
  const version = azure.azureApiVersion || request.env?.AZURE_OPENAI_API_VERSION || "v1";
  return `${root}/openai/deployments/${encodeURIComponent(deployment)}/responses?api-version=${encodeURIComponent(version)}`;
}

/** Re-export so callers can see Azure and OpenAI share one responses implementation. */
export { openAIResponsesApi };
