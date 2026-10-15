/**
 * Jev 1.14: locate on a small image, crop the upright original and ask again.
 * From packages/coding-agent:
 *   node examples/sdk/15-typesafe-crop.ts page.png "the entire table" ./crop-output
 * Uses TYPESAFE_API_KEY or the agent's saved TypeSafe credentials. Outputs PNG + JSON.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as photon from "@silvia-odwyer/photon-node";
import type { ClassifierBoxCoordinates, ClassifierContext, ClassifierResult, ImageContent } from "@amazme/ai";
import { applyExifOrientation } from "../../src/utils/exif-orientation.ts";

// Example policy only: calibrate these on your own images.
const MIN_PRESENCE = 0.8;
const MIN_CONFIDENCE = 0.7;
const MIN_SIDE = 280; // Conservative service compatibility; official protocol minimum is 256 and 78,400 pixels.
const MAX_SIDE = 1568;
type PixelBox = [left: number, top: number, right: number, bottom: number];
type Ask = (context: ClassifierContext, signal?: AbortSignal) => Promise<ClassifierResult>;

export interface CropResult {
	status: "located" | "review" | "error";
	reason?: string;
	/** Pixel coordinates in the upright original, before any downscaling. */
	box?: PixelBox;
	crop?: ImageContent;
	calls: ClassifierResult[];
}

function encode(image: photon.PhotonImage, preferredSide: number): ImageContent {
	const width = image.get_width(),
		height = image.get_height();
	const scale = Math.max(Math.min(1, preferredSide / Math.max(width, height)), MIN_SIDE / Math.min(width, height));
	if (scale > 1 || Math.ceil(Math.max(width, height) * scale) > MAX_SIDE) {
		throw new Error("Image or crop cannot fit the example's limits without upscaling or tiling");
	}
	const resized = photon.resize(
		image,
		Math.ceil(width * scale),
		Math.ceil(height * scale),
		photon.SamplingFilter.Lanczos3,
	);
	try {
		return { type: "image", mimeType: "image/png", data: Buffer.from(resized.get_bytes()).toString("base64") };
	} finally {
		resized.free();
	}
}

function accepted(result: ClassifierResult): ClassifierBoxCoordinates | undefined {
	const present = result.answers.present,
		target = result.answers.target;
	if (
		present?.type !== "bool" ||
		!Number.isFinite(present.probability) ||
		present.probability < MIN_PRESENCE ||
		present.probability > 1 ||
		target?.type !== "box" ||
		!Number.isFinite(target.confidence) ||
		target.confidence < MIN_CONFIDENCE ||
		target.confidence > 1
	)
		return;
	const b = target.box;
	if (!Object.values(b).every((v) => Number.isFinite(v) && v >= 0 && v <= 1) || b.left >= b.right || b.top >= b.bottom)
		return;
	return b;
}

/** Expands a candidate crop in original pixels, without stretching the image or silently clipping to an invalid size. */
function cropBounds(box: ClassifierBoxCoordinates, width: number, height: number): PixelBox {
	const expand = (start: number, end: number, size: number): [number, number] => {
		const padding = Math.ceil(0.05 * size);
		let low = Math.max(0, Math.floor(start * size) - padding);
		let high = Math.min(size, Math.ceil(end * size) + padding);
		if (high - low < MIN_SIDE) {
			const center = (low + high) / 2;
			low = Math.max(0, Math.min(size - MIN_SIDE, Math.floor(center - MIN_SIDE / 2)));
			high = low + MIN_SIDE;
		}
		return [low, high];
	};
	const [left, right] = expand(box.left, box.right, width),
		[top, bottom] = expand(box.top, box.bottom, height);
	return [left, top, right, bottom];
}

export async function locateWithCrop(
	bytes: Uint8Array,
	target: string,
	ask: Ask,
	signal?: AbortSignal,
): Promise<CropResult> {
	signal?.throwIfAborted();
	if (!target.trim()) throw new Error("A target description is required");
	const original = photon.PhotonImage.new_from_byteslice(bytes);
	let upright = original;
	const calls: ClassifierResult[] = [];
	const judge = async (image: ImageContent): Promise<ClassifierResult> => {
		signal?.throwIfAborted();
		const reference = randomUUID();
		const result = await ask(
			{
				state: { target, observation: { picture: reference } },
				assets: { [reference]: image },
				questions: {
					present: {
						type: "bool",
						instructions: { question: "Is `target` visible in `observation.picture`?" },
						criteria: {
							true: { condition: "The described target is visible" },
							false: { condition: "Absent or not distinguishable" },
						},
					},
					target: {
						type: "box",
						instructions: [
							"The complete target described in `target`, in `observation.picture`.",
							"Include the entire target rather than one part of it.",
						],
					},
				},
			},
			signal,
		);
		calls.push(result);
		signal?.throwIfAborted();
		return result;
	};
	try {
		upright = applyExifOrientation(photon, original, bytes);
		const coarse = await judge(encode(upright, 640));
		if (coarse.stopReason !== "stop")
			return { status: "error", reason: coarse.errorMessage ?? coarse.stopReason, calls };
		const coarseBox = accepted(coarse);
		if (!coarseBox) return { status: "review", reason: "Coarse presence or localization is insufficient", calls };
		const bounds = cropBounds(coarseBox, upright.get_width(), upright.get_height());
		const region = photon.crop(upright, ...bounds);
		try {
			const fine = await judge(encode(region, MAX_SIDE));
			if (fine.stopReason !== "stop") return { status: "error", reason: fine.errorMessage ?? fine.stopReason, calls };
			const fineBox = accepted(fine);
			if (!fineBox)
				return {
					status: "review",
					reason: "Crop presence or localization is insufficient; thresholds were not lowered",
					calls,
				};
			const [left, top, right, bottom] = bounds;
			const box: PixelBox = [
				left + Math.floor(fineBox.left * (right - left)),
				top + Math.floor(fineBox.top * (bottom - top)),
				left + Math.ceil(fineBox.right * (right - left)),
				top + Math.ceil(fineBox.bottom * (bottom - top)),
			];
			const cropped = photon.crop(upright, ...box);
			try {
				return {
					status: "located",
					box,
					crop: { type: "image", data: Buffer.from(cropped.get_bytes()).toString("base64"), mimeType: "image/png" },
					calls,
				};
			} finally {
				cropped.free();
			}
		} finally {
			region.free();
		}
	} finally {
		if (upright !== original) upright.free();
		original.free();
	}
}

async function main(): Promise<void> {
	const [path, target, directory] = process.argv.slice(2);
	if (!path || !target || !directory)
		throw new Error('Usage: node examples/sdk/15-typesafe-crop.ts <image> "<target>" <output-directory>');
	const { ModelRuntime } = await import("@amazme/coding-agent");
	const runtime = await ModelRuntime.create();
	const model = runtime.getModelOfType("classifier", "typesafe", "jev-1.14.0");
	if (!model) throw new Error("TypeSafe jev-1.14.0 is not in the catalog");
	const controller = new AbortController();
	const interrupt = () => controller.abort(new Error("Cancelled"));
	process.once("SIGINT", interrupt);
	try {
		const result = await locateWithCrop(
			await readFile(resolve(path)),
			target,
			(context, signal) => runtime.classify(model, context, { signal }),
			controller.signal,
		);
		const { crop, ...report } = result;
		const usage = result.calls.reduce(
			(sum, call) => ({
				inputTokens: sum.inputTokens + (call.usage?.input ?? 0),
				outputTokens: sum.outputTokens + (call.usage?.output ?? 0),
				cost: sum.cost + (call.usage?.cost.total ?? 0),
			}),
			{ inputTokens: 0, outputTokens: 0, cost: 0 },
		);
		await mkdir(resolve(directory), { recursive: true });
		await writeFile(join(resolve(directory), "result.json"), JSON.stringify({ ...report, usage }, null, 2));
		if (crop) await writeFile(join(resolve(directory), "target.png"), Buffer.from(crop.data, "base64"));
		else await rm(join(resolve(directory), "target.png"), { force: true });
		console.log(
			JSON.stringify({
				status: result.status,
				box: result.box,
				reason: result.reason,
				usage,
				directory: resolve(directory),
			}),
		);
		if (result.status === "error") process.exitCode = 1;
	} finally {
		process.off("SIGINT", interrupt);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}
