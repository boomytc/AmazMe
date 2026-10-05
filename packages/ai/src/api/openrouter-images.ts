import type { ImageModel, ImageRequest, ImageResult, SpecialCallOptions } from "../types.ts";

/**
 * OpenRouter image generation over chat completions.
 * The response `message.images[].image_url.url` values are the images.
 */
export async function generateOpenRouterImages(
  model: ImageModel,
  request: ImageRequest,
  options: SpecialCallOptions = {},
): Promise<ImageResult> {
  const base: ImageResult = { api: model.api, provider: model.provider, model: model.id, images: [], stopReason: "error" };
  if (!options.apiKey) return { ...base, errorMessage: `No API key for provider: ${model.provider}` };
  const root = (options.baseUrl ?? model.baseUrl).replace(/\/+$/u, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(`${root}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: request.prompt }] }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) return { ...base, errorMessage: `OpenRouter images returned ${response.status}` };
  const body = await response.json() as {
    choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } | string }> } }>;
  };
  const images = (body.choices?.[0]?.message?.images ?? []).map((image) => {
    const url = image.image_url;
    return typeof url === "string" ? url : url?.url ?? "";
  }).filter((url) => url.length > 0);
  return { ...base, stopReason: "stop", images };
}
