import * as photon from "@silvia-odwyer/photon-node";
import type { ClassifierBoxCoordinates, ClassifierResult } from "@amazme/ai";
import { describe, expect, it, vi } from "vitest";
import { locateWithCrop } from "../examples/sdk/15-typesafe-crop.ts";

function picture(width = 1200, height = 1600): Uint8Array {
	const image = new photon.PhotonImage(new Uint8Array(width * height * 4).fill(255), width, height);
	try {
		return image.get_bytes();
	} finally {
		image.free();
	}
}

function answer(box: ClassifierBoxCoordinates, presence = 0.98, confidence = 0.9): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "typesafe",
		model: "jev-1.14.0",
		timestamp: 0,
		stopReason: "stop",
		answers: { present: { type: "bool", probability: presence }, target: { type: "box", box, confidence } },
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0.0000042, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0000042 },
		},
	};
}
type Ask = Parameters<typeof locateWithCrop>[2];
const coarse = { left: 0.1, top: 0.2, right: 0.8, bottom: 0.5 };

describe("TypeSafe crop-and-reask example", () => {
	it("encodes real images, asks on the original crop and maps the fine box to original pixels", async () => {
		const ask = vi
			.fn<Ask>()
			.mockResolvedValueOnce(answer(coarse))
			.mockResolvedValueOnce(answer({ left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 }));
		const result = await locateWithCrop(picture(), "the entire table", ask);
		expect(result.status).toBe("located");
		expect(result.box).toEqual([252, 304, 828, 816]);
		expect(result.calls.map((call) => call.usage?.input)).toEqual([100, 100]);
		expect(ask).toHaveBeenCalledTimes(2);
		const sizes = ask.mock.calls.map(([context]) => {
			const assets = Object.values(context.assets ?? {});
			expect(assets).toHaveLength(1);
			const image = photon.PhotonImage.new_from_byteslice(Buffer.from(assets[0].data, "base64"));
			try {
				return [image.get_width(), image.get_height()];
			} finally {
				image.free();
			}
		});
		expect(sizes).toEqual([
			[480, 640],
			[960, 640],
		]);
		const crop = photon.PhotonImage.new_from_byteslice(Buffer.from(result.crop!.data, "base64"));
		try {
			expect([crop.get_width(), crop.get_height()]).toEqual([576, 512]);
		} finally {
			crop.free();
		}
	});

	it("maps both rounds to the upright original when JPEG EXIF rotates its dimensions", async () => {
		const image = photon.PhotonImage.new_from_byteslice(picture());
		let jpeg: Uint8Array;
		try {
			jpeg = image.get_bytes_jpeg(90);
		} finally {
			image.free();
		}
		const exif = Buffer.concat([
			Buffer.from("Exif\0\0"),
			Buffer.from("49492a0008000000010012010300010000000600000000000000", "hex"),
		]);
		const segment = Buffer.alloc(exif.length + 4);
		segment[0] = 0xff;
		segment[1] = 0xe1;
		segment.writeUInt16BE(exif.length + 2, 2);
		segment.set(exif, 4);
		const rotated = Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
		const ask = vi
			.fn<Ask>()
			.mockResolvedValueOnce(answer(coarse))
			.mockResolvedValueOnce(answer({ left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 }));
		const result = await locateWithCrop(rotated, "table", ask);
		expect(result.status).toBe("located");
		expect(result.box).toEqual([336, 228, 1104, 612]);
		const firstImage = Object.values(ask.mock.calls[0][0].assets ?? {})[0];
		const uploaded = photon.PhotonImage.new_from_byteslice(Buffer.from(firstImage.data, "base64"));
		try {
			expect([uploaded.get_width(), uploaded.get_height()]).toEqual([640, 480]);
		} finally {
			uploaded.free();
		}
	});

	it("does not send a second request when target presence is low", async () => {
		const ask = vi.fn<Ask>().mockResolvedValue(answer(coarse, 0.02));
		const result = await locateWithCrop(picture(), "missing signature", ask);
		expect(result.status).toBe("review");
		expect(result.crop).toBeUndefined();
		expect(ask).toHaveBeenCalledOnce();
	});

	it("does not adopt a low-confidence fine box or lower the threshold", async () => {
		const ask = vi
			.fn<Ask>()
			.mockResolvedValueOnce(answer(coarse))
			.mockResolvedValueOnce(answer(coarse, 0.98, 0.4));
		const result = await locateWithCrop(picture(), "table", ask);
		expect(result.status).toBe("review");
		expect(result.crop).toBeUndefined();
		expect(result.calls).toHaveLength(2);
	});

	it("rejects an invalid source image size before any inference", async () => {
		const ask = vi.fn<Ask>();
		await expect(locateWithCrop(picture(100, 100), "table", ask)).rejects.toThrow("without upscaling or tiling");
		expect(ask).not.toHaveBeenCalled();
	});

	it("preserves provider failure and billed usage", async () => {
		const ask = vi
			.fn<Ask>()
			.mockResolvedValue({ ...answer(coarse), stopReason: "error", errorMessage: "malformed billed answer" });
		const result = await locateWithCrop(picture(), "table", ask);
		expect(result).toMatchObject({
			status: "error",
			reason: "malformed billed answer",
			calls: [{ usage: { input: 100 } }],
		});
	});

	it("propagates cancellation and does not start crop inference", async () => {
		const controller = new AbortController();
		const ask = vi.fn<Ask>(async (_context, signal) => {
			expect(signal).toBe(controller.signal);
			controller.abort();
			return answer(coarse);
		});
		await expect(locateWithCrop(picture(), "table", ask, controller.signal)).rejects.toThrow();
		expect(ask).toHaveBeenCalledOnce();
	});
});
