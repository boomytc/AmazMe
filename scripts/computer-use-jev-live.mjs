import assert from "node:assert/strict";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { DEFAULT_COMPUTER_USE_SETTINGS } from "../packages/coding-agent/plugins/computer-use/src/config.ts";
import { groundAndAct } from "../packages/coding-agent/plugins/computer-use/src/runtime.ts";
import {
	createJevTrace,
	assertGroundingEvidence,
} from "./computer-use-live-evidence.mjs";

// Uses the same model/auth runtime and grounding pipeline as the product.
// Fixture state is an independent oracle, never an input to the classifier.
export async function createJevValidation({
	driver,
	output,
	report,
	save,
	step,
	signal,
}) {
	const policy = { ...DEFAULT_COMPUTER_USE_SETTINGS, enabled: true };
	const models = await ModelRuntime.create({
		refreshOnCreate: false,
		allowModelNetwork: false,
		signal: signal(),
	});
	const model = models.getModelOfType(
		"classifier",
		policy.jevProvider,
		policy.jevModel,
	);
	assert.ok(model, "Configured Jev classifier is unavailable");
	assert.ok(
		(await models.getAuth(policy.jevProvider, { signal: signal() }))?.auth
			.apiKey,
		"Configure TypeSafe credentials before online validation",
	);
	report.jev = {
		provider: model.provider,
		model: model.id,
		policy,
		trace: "jev-trace.json",
	};
	const trace = createJevTrace(output, (input, abortSignal) =>
		models.classify(model, input, { signal: abortSignal }),
	);
	await save();
	const run = (target, goal, verification, action = "click", text) =>
		trace.run((classify) =>
			groundAndAct(
				driver,
				target,
				goal,
				verification,
				action,
				text,
				classify,
				policy,
				signal(),
			),
		);
	const healthy = (result) => {
		assert.ok(result.calls?.length > 0, "No online classifier calls recorded");
		assert.ok(
			result.calls.every((call) => call.stopReason === "stop"),
			"An online classifier request failed",
		);
	};
	const verified = (result, route) => {
		healthy(result);
		assert.equal(result.status, "verified", result.reason);
		assert.equal(result.acted, true);
		assert.equal(result.verified, true);
		assert.ok(result.verification_probability >= policy.minPresence);
		assert.ok(
			result.calls.some((call) => call.answers.risk_destructive),
			"Missing action risk assessment",
		);
		result.grounding_route = assertGroundingEvidence(
			trace.forResult(result),
			route,
			policy,
		);
	};
	return {
		async native(target, read) {
			await step(
				"Jev native AX click",
				read,
				() =>
					run(
						target,
						"Click the Increment Native button once.",
						"The Native Counter label shows 1.",
					),
				(a, b) => a.nativeCount === b.nativeCount + 1,
				(_after, result) => verified(result, "ax"),
			);
			await step(
				"Jev native AX text input",
				read,
				() =>
					run(
						target,
						"Type Jev 038 into the empty Smoke Input field.",
						"The Smoke Input field contains exactly Jev 038.",
						"type_text",
						"Jev 038",
					),
				(a) => a.text === "Jev 038",
				(_after, result) => verified(result, "ax"),
			);
			await step(
				"Jev append respects the risk decision",
				read,
				() =>
					run(
						target,
						"Append OK to the Smoke Input field.",
						"The Smoke Input field contains exactly Jev 038 OK.",
						"type_text",
						" OK",
					),
				(a, b, result) => a.text === (result.acted ? `${b.text} OK` : b.text),
				(after, result, before) => {
					healthy(result);
					assert.equal(after.nativeCount, before.nativeCount);
					assert.equal(after.canvasCount, before.canvasCount);
					assert.equal(after.valueText, before.valueText);
					assert.equal(after.rightCount, before.rightCount);
					assert.equal(after.dragCount, before.dragCount);
					assert.equal(after.scrollTotal, before.scrollTotal);
					if (result.acted) verified(result, "ax");
					else {
						assert.equal(result.status, "review");
						assert.ok(!result.applied);
						assert.ok(
							result.calls.some((call) =>
								Object.entries(call.answers).some(
									([name, answer]) =>
										name.startsWith("risk_") &&
										answer.type === "bool" &&
										answer.probability > 1 - policy.minPresence,
								),
							),
							"Refusal must be explained by the recorded risk probabilities",
						);
					}
				},
			);
			await step(
				"Jev native AX set value",
				read,
				() =>
					run(
						target,
						"Set the empty Smoke Value field to Jev verified.",
						"The Smoke Value field contains exactly Jev verified.",
						"set_value",
						"Jev verified",
					),
				(a) => a.valueText === "Jev verified",
				(_after, result) => verified(result, "ax"),
			);
			await step(
				"Jev native visual click",
				read,
				() =>
					run(
						target,
						"Click the blue Increment Canvas control once.",
						"The blue panel shows Canvas Counter: 1.",
					),
				(a, b) => a.canvasCount === b.canvasCount + 1,
				(_after, result) => verified(result, "visual"),
			);
			await step(
				"Jev missing target refuses action",
				read,
				() =>
					run(
						target,
						"Click the orange Banana button.",
						"The Banana counter increased.",
					),
				(a, b) =>
					a.nativeCount === b.nativeCount &&
					a.canvasCount === b.canvasCount &&
					a.text === b.text &&
					a.valueText === b.valueText &&
					a.rightCount === b.rightCount &&
					a.dragCount === b.dragCount &&
					a.scrollTotal === b.scrollTotal,
				(_after, result) => {
					healthy(result);
					assert.equal(result.status, "review");
					assert.notEqual(result.acted, true);
					assert.ok(!result.applied);
				},
			);
			await step(
				"Jev false postcondition is rejected",
				read,
				() =>
					run(
						target,
						"Click the Increment Native button once.",
						"The Native Counter label equals 999.",
					),
				(a, b) => a.nativeCount === b.nativeCount + 1,
				(_after, result) => {
					healthy(result);
					assert.equal(result.status, "review");
					assert.equal(result.acted, true);
					assert.equal(result.verified, false);
					assert.ok(result.verification_probability <= 1 - policy.minPresence);
				},
			);
		},
		async browser(name, target, read) {
			await step(
				`Jev ${name} visual click`,
				read,
				() =>
					run(
						target,
						"Click the blue Canvas Counter panel once.",
						"The blue panel shows Canvas Counter: 1.",
					),
				(a, b) => a.canvasCount === b.canvasCount + 1,
				(_after, result) => verified(result, "visual"),
			);
		},
	};
}
