/// <reference lib="dom" />
/**
 * The page's image intake: decode once, honour the encoder's orientation, and keep the payload
 * within the provider limits the one-shot CLI applies. A file already inside the limits is sent
 * byte-for-byte, so an animated GIF stays animated.
 */
import type { ImagePart } from "../generated/contracts.ts";
import type { Locale } from "../locale.ts";
import { translate } from "../strings.ts";
import { ATTACHMENT_TYPES } from "../view.ts";

type MediaType = ImagePart["media_type"];

/** The longest edge a provider-bound image keeps. Matches the CLI's resize defaults. */
const MAX_EDGE = 2000;
/** The encoded base64 payload stays below the 5 MB provider ceiling with headroom. */
const MAX_ENCODED = Math.floor(4.5 * 1024 * 1024);
/** Refuse absurd inputs before decoding; browsers decode large images in memory. */
const MAX_INPUT = 32 * 1024 * 1024;
const JPEG_QUALITIES = [0.8, 0.7, 0.55, 0.4];

export interface PreparedImage {
	readonly name: string;
	readonly dataUrl: string;
	readonly mediaType: MediaType;
	/** Decoded bytes, which the composer shows. */
	readonly bytes: number;
	readonly base64: string;
}

interface Encoded {
	readonly mediaType: MediaType;
	readonly blob: Blob;
	readonly base64: string;
}

function readBase64(file: Blob): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error("image_read_failed"));
				return;
			}
			resolve(reader.result.slice(reader.result.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("image_read_failed"));
		reader.readAsDataURL(file);
	});
}

async function decode(file: File): Promise<ImageBitmap | undefined> {
	try {
		return await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		return undefined;
	}
}

async function encodeCanvas(canvas: HTMLCanvasElement, mediaType: MediaType, quality?: number): Promise<Encoded | undefined> {
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mediaType, quality));
	if (blob === null || blob.size === 0) return undefined;
	const base64 = await readBase64(blob);
	return { mediaType, blob, base64 };
}

function base64Bytes(base64: string): number {
	return Math.ceil((base64.length * 3) / 4);
}

/** Shrink to the provider limits; pick the smallest encoding that still fits, stepping down dimensions. */
async function reduce(bitmap: ImageBitmap): Promise<Encoded> {
	const scale = Math.min(1, MAX_EDGE / bitmap.width, MAX_EDGE / bitmap.height);
	let width = Math.max(1, Math.round(bitmap.width * scale));
	let height = Math.max(1, Math.round(bitmap.height * scale));
	const canvas = document.createElement("canvas");
	const context = canvas.getContext("2d");
	if (context === null) throw new Error("image_canvas_unavailable");
	for (let attempt = 0; attempt < 12; attempt++) {
		canvas.width = width;
		canvas.height = height;
		context.clearRect(0, 0, width, height);
		context.drawImage(bitmap, 0, 0, width, height);
		const candidates: Encoded[] = [];
		const png = await encodeCanvas(canvas, "image/png");
		if (png !== undefined) candidates.push(png);
		for (const quality of JPEG_QUALITIES) {
			const jpeg = await encodeCanvas(canvas, "image/jpeg", quality);
			if (jpeg !== undefined) candidates.push(jpeg);
		}
		const fitting = candidates
			.filter((candidate) => base64Bytes(candidate.base64) <= MAX_ENCODED)
			.sort((left, right) => left.blob.size - right.blob.size)[0];
		if (fitting !== undefined) return fitting;
		if (width <= 64 || height <= 64) break;
		width = Math.max(1, Math.round(width * 0.8));
		height = Math.max(1, Math.round(height * 0.8));
	}
	throw new Error("image_too_large");
}

/** Read one picked image into the exact payload the prompt carries, or throw a reader-facing error. */
export async function prepareImageFile(file: File, locale: Locale): Promise<PreparedImage> {
	const originalType = file.type as MediaType;
	if (!ATTACHMENT_TYPES.includes(originalType))
		throw new Error(translate(locale, "composer.attachmentUnsupported"));
	if (file.size > MAX_INPUT) throw new Error(translate(locale, "composer.attachmentTooLarge"));
	const original = await readBase64(file).catch(() => {
		throw new Error(translate(locale, "composer.imageUnreadable"));
	});
	const bitmap = await decode(file);
	if (bitmap === undefined) throw new Error(translate(locale, "composer.imageUnreadable"));
	try {
		if (base64Bytes(original) <= MAX_ENCODED && bitmap.width <= MAX_EDGE && bitmap.height <= MAX_EDGE)
			return {
				name: file.name,
				dataUrl: `data:${originalType};base64,${original}`,
				mediaType: originalType,
				bytes: file.size,
				base64: original,
			};
		const encoded = await reduce(bitmap);
		return {
			name: file.name,
			dataUrl: `data:${encoded.mediaType};base64,${encoded.base64}`,
			mediaType: encoded.mediaType,
			bytes: encoded.blob.size,
			base64: encoded.base64,
		};
	} catch (error) {
		if (error instanceof Error && error.message === "image_too_large")
			throw new Error(translate(locale, "composer.attachmentTooLarge"));
		throw error;
	} finally {
		bitmap.close();
	}
}
