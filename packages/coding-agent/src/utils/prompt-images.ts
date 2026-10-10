import type { ImageContent } from "@amazme/ai";
import { processImage, type ProcessImageOptions } from "./image-process.ts";

/** Normalize new input once before persistence, using the selected model's image limits. */
export async function normalizePromptImages(
	images: readonly ImageContent[] | undefined,
	options: ProcessImageOptions,
	signal?: AbortSignal,
): Promise<{ images: ImageContent[]; hints: string[] }> {
	const normalized: ImageContent[] = [];
	const hints: string[] = [];
	for (const image of images ?? []) {
		signal?.throwIfAborted();
		const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, options);
		signal?.throwIfAborted();
		if (!processed.ok) {
			hints.push(processed.message);
			continue;
		}
		normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		hints.push(...processed.hints);
	}
	return { images: normalized, hints };
}
