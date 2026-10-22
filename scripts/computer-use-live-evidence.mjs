import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as photon from "@silvia-odwyer/photon-node";

export function createJevTrace(output, classify, limit = 64) {
	const records = [];
	const save = () =>
		writeFile(
			join(output, "jev-trace.json"),
			`${JSON.stringify(records, null, 2)}\n`,
		);
	const recorded = async (input, signal) => {
		const entry = {
			sequence: records.length + 1,
			state: input.state,
			questions: input.questions,
			assets: {},
		};
		records.push(entry);
		const started = Date.now();
		try {
			assert.ok(
				entry.sequence <= limit,
				"Online validation request budget exhausted",
			);
			signal?.throwIfAborted();
			for (const [id, asset] of Object.entries(input.assets ?? {})) {
				assert.equal(asset.type, "image");
				assert.equal(asset.mimeType, "image/png");
				const bytes = Buffer.from(asset.data, "base64");
				const image = photon.PhotonImage.new_from_byteslice(bytes);
				let width, height;
				try {
					width = image.get_width();
					height = image.get_height();
				} finally {
					image.free();
				}
				assert.ok(
					Math.min(width, height) >= 280 && Math.max(width, height) <= 1568,
					"Invalid Jev image dimensions",
				);
				const file = `jev-${entry.sequence}-${Object.keys(entry.assets).length}.png`;
				await writeFile(join(output, file), bytes);
				entry.assets[id] = {
					file,
					mimeType: asset.mimeType,
					width,
					height,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				};
			}
			await save();
			signal?.throwIfAborted();
			entry.response = await classify(input, signal);
			return entry.response;
		} catch (error) {
			entry.error = String(error);
			throw error;
		} finally {
			entry.elapsedMs = Date.now() - started;
			await save();
		}
	};
	return {
		async run(work) {
			const start = records.length;
			const result = await work(recorded);
			const calls = records.slice(start);
			// Grounding may convert an exception into review and omit it from result.calls.
			assert.ok(
				calls.length &&
					calls.every(
						(call) => !call.error && call.response?.stopReason === "stop",
					),
				"Incomplete or failed online classification evidence",
			);
			return { ...result, trace: { first: start + 1, last: records.length } };
		},
		forResult(result) {
			return records.slice(result.trace.first - 1, result.trace.last);
		},
	};
}

export function assertGroundingEvidence(records, route, policy) {
	const boxes = records.filter((r) => r.questions.target?.type === "box");
	if (route === "ax") {
		assert.equal(boxes.length, 0, "Expected an AX selection");
		assert.ok(
			records.some((r) => {
				const answer = r.response.answers.candidate;
				return (
					answer?.type === "choice" &&
					answer.confidence >= policy.minChoiceConfidence &&
					answer.confidence <= 1 &&
					answer.choice.startsWith("ax_") &&
					Object.hasOwn(r.questions.candidate.criteria, answer.choice)
				);
			}),
			"Missing confident AX selection",
		);
		return "ax";
	}
	const acceptedBox = (record) => {
		const { target, present } = record?.response?.answers ?? {};
		assert.ok(
			present?.type === "bool" &&
				present.probability >= policy.minPresence &&
				present.probability <= 1,
		);
		assert.ok(
			target?.type === "box" &&
				target.confidence >= policy.minBoxConfidence &&
				target.confidence <= 1,
		);
		const { left, top, right, bottom } = target.box;
		assert.ok(
			0 <= left &&
				left < right &&
				right <= 1 &&
				0 <= top &&
				top < bottom &&
				bottom <= 1,
		);
		const images = Object.values(record.assets);
		assert.equal(images.length, 1);
		assert.match(images[0].sha256, /^[a-f0-9]{64}$/u);
		return images[0];
	};
	const last = boxes.at(-1),
		finalImage = acceptedBox(last);
	const tile = records.findLast((r) => r.questions.tile);
	if (tile) {
		const choice = tile.response.answers.tile;
		assert.ok(
			choice?.type === "choice" &&
				choice.confidence >= policy.minChoiceConfidence &&
				choice.confidence <= 1,
		);
		const selected = tile.assets[tile.state.observation[choice.choice]];
		assert.ok(
			selected && tile.sequence < last.sequence,
			"Missing selected tile before Box",
		);
		assert.equal(
			finalImage.sha256,
			selected.sha256,
			"Box must receive the selected tile",
		);
		return "tiled";
	}
	assert.ok(boxes.length >= 2, "Missing coarse and fine Box requests");
	const coarse = acceptedBox(boxes.at(-2));
	assert.notEqual(
		finalImage.sha256,
		coarse.sha256,
		"Fine localization must use a distinct image",
	);
	return "crop";
}

export async function recordLiveStep({
	name,
	read,
	action,
	accept,
	verify = () => {},
	report,
	probe,
	waitFor,
	save,
}) {
	const record = { name };
	report.steps.push(record);
	try {
		record.before = await read();
		record.desktopBefore = await probe();
		record.result = await action();
		await save();
		await waitFor(
			read,
			(value) => value && accept(value, record.before, record.result),
		);
		await delay(250);
		record.after = await read();
		assert.ok(
			record.after && accept(record.after, record.before, record.result),
			`${name}: postcondition did not remain satisfied`,
		);
		record.desktopAfter = await probe();
		assert.equal(
			record.desktopAfter.frontmostPid,
			record.desktopBefore.frontmostPid,
			`${name}: foreground changed`,
		);
		assert.ok(
			Math.hypot(
				record.desktopAfter.pointerX - record.desktopBefore.pointerX,
				record.desktopAfter.pointerY - record.desktopBefore.pointerY,
			) <= 1,
			`${name}: pointer moved`,
		);
		verify(record.after, record.result, record.before);
		record.passed = true;
	} catch (error) {
		record.error = String(error);
		record.passed = false;
		try {
			record.after ??= await read();
			record.desktopAfter ??= await probe();
		} catch (observationError) {
			record.observationError = String(observationError);
		}
	} finally {
		// Keep the exact observations that were checked; never replace them after PASS.
		await save();
	}
	return record;
}
