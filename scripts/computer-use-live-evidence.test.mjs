import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as photon from "@silvia-odwyer/photon-node";
import {
	createJevTrace,
	assertGroundingEvidence,
	recordLiveStep,
} from "./computer-use-live-evidence.mjs";

const success = { stopReason: "stop", answers: {} };
const question = { state: {}, questions: { present: { type: "bool" } } };

test("a swallowed classifier failure cannot pass as a safe review, and its error is saved", async () => {
	const output = await mkdtemp(join(tmpdir(), "amcu-evidence-"));
	try {
		let count = 0;
		const trace = createJevTrace(output, async () => {
			if (++count === 1) return success;
			throw new Error("service unavailable");
		});
		await assert.rejects(
			trace.run(async (classify) => {
				const first = await classify(question);
				try {
					await classify(question);
				} catch {
					/* Grounding returns review on lookup failure. */
				}
				return { status: "review", calls: [first] };
			}),
			/Incomplete or failed/,
		);
		const saved = JSON.parse(
			await readFile(join(output, "jev-trace.json"), "utf8"),
		);
		assert.equal(saved.length, 2);
		assert.match(saved[1].error, /service unavailable/);
		assert.equal(saved[0].response.stopReason, "stop");
	} finally {
		await rm(output, { recursive: true, force: true });
	}
});

test("request budget and cancellation stop the transport even when the caller catches errors", async () => {
	const output = await mkdtemp(join(tmpdir(), "amcu-evidence-"));
	try {
		let called = 0;
		const trace = createJevTrace(
			output,
			async () => {
				called++;
				return success;
			},
			1,
		);
		await trace.run(async (classify) => ({
			calls: [await classify(question)],
		}));
		await assert.rejects(
			trace.run(async (classify) => {
				await classify(question).catch(() => {});
				return { status: "review" };
			}),
			/Incomplete or failed/,
		);
		assert.equal(called, 1);
		const cancelled = createJevTrace(output, async () => {
			called++;
			return success;
		});
		await assert.rejects(
			cancelled.run(async (classify) => {
				await classify(
					question,
					AbortSignal.abort(new Error("cancelled")),
				).catch(() => {});
				return { status: "review" };
			}),
			/Incomplete or failed/,
		);
		assert.equal(called, 1);
	} finally {
		await rm(output, { recursive: true, force: true });
	}
});

test("trace records the real image dimensions and hash and rejects undersized images before transport", async () => {
	const output = await mkdtemp(join(tmpdir(), "amcu-evidence-"));
	try {
		let called = 0;
		const trace = createJevTrace(output, async () => {
			called++;
			return success;
		});
		for (const width of [280, 279]) {
			const image = new photon.PhotonImage(
				new Uint8Array(width * 300 * 4),
				width,
				300,
			);
			let data;
			try {
				data = Buffer.from(image.get_bytes()).toString("base64");
			} finally {
				image.free();
			}
			const input = {
				...question,
				state: { picture: "picture" },
				assets: { picture: { type: "image", mimeType: "image/png", data } },
			};
			const operation = trace.run(async (classify) => ({
				calls: [await classify(input)],
			}));
			if (width === 279)
				await assert.rejects(operation, /Invalid Jev image dimensions/);
			else {
				const result = await operation;
				const asset = trace.forResult(result)[0].assets.picture;
				assert.equal(asset.width, 280);
				assert.equal(asset.height, 300);
				assert.match(asset.sha256, /^[a-f0-9]{64}$/u);
				assert.ok((await readFile(join(output, asset.file))).length);
			}
		}
		assert.equal(called, 1);
	} finally {
		await rm(output, { recursive: true, force: true });
	}
});

test("visual evidence distinguishes crop from selected-tile fallback and rejects replayed or wrong images", () => {
	const policy = {
		minPresence: 0.8,
		minBoxConfidence: 0.7,
		minChoiceConfidence: 0.7,
	};
	const box = (sequence, hash) => ({
		sequence,
		questions: { target: { type: "box" } },
		assets: { picture: { sha256: hash.repeat(64) } },
		response: {
			answers: {
				present: { type: "bool", probability: 0.99 },
				target: {
					type: "box",
					confidence: 0.9,
					box: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
				},
			},
		},
	});
	assert.equal(
		assertGroundingEvidence([box(1, "a"), box(2, "b")], "visual", policy),
		"crop",
	);
	assert.throws(
		() => assertGroundingEvidence([box(1, "a"), box(2, "a")], "visual", policy),
		/distinct image/,
	);
	const tile = {
		sequence: 2,
		questions: { tile: {} },
		state: { observation: { tile_0_1: "chosen" } },
		assets: { chosen: { sha256: "b".repeat(64) } },
		response: {
			answers: {
				tile: { type: "choice", choice: "tile_0_1", confidence: 0.9 },
			},
		},
	};
	assert.equal(
		assertGroundingEvidence([box(1, "a"), tile, box(3, "b")], "visual", policy),
		"tiled",
	);
	assert.throws(
		() =>
			assertGroundingEvidence(
				[box(1, "a"), tile, box(3, "c")],
				"visual",
				policy,
			),
		/selected tile/,
	);
	const absent = box(2, "b");
	absent.response.answers.present.probability = 0.1;
	assert.throws(() =>
		assertGroundingEvidence([box(1, "a"), absent], "visual", policy),
	);
});

test("a passing step persists only its checked observations; changed postconditions and startup failures fail", async () => {
	for (const mode of ["pass", "changed", "startup-failure"]) {
		const states = [
			{ count: 0 },
			{ count: 1 },
			{ count: mode === "changed" ? 2 : 1 },
			{ count: 999 },
		];
		let reads = 0,
			saved;
		const report = { steps: [] };
		const record = await recordLiveStep({
			name: mode,
			report,
			read: async () => {
				if (mode === "startup-failure") throw new Error("fixture unavailable");
				return states[reads++];
			},
			probe: async () => ({ frontmostPid: 42, pointerX: 1, pointerY: 2 }),
			action: async () => ({ status: "acted" }),
			accept: (a, b) => a.count === b.count + 1,
			waitFor: async (read, accept) => {
				const state = await read();
				assert.ok(accept(state));
				return state;
			},
			save: async () => {
				saved = structuredClone(report);
			},
		});
		assert.equal(record.passed, mode === "pass");
		assert.deepEqual(saved.steps[0], record);
		if (mode !== "startup-failure") assert.equal(reads, 3);
		if (mode === "pass") assert.deepEqual(record.after, { count: 1 });
		else
			assert.match(
				record.error,
				mode === "changed" ? /did not remain satisfied/ : /fixture unavailable/,
			);
	}
});
