import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierBoxAnswer,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { isRecord, parseClassifierUsage, postClassifierRequest, requiredNumber } from "./classifier-shared.ts";

/** TypeSafe System One request body without the transport-specific envelope. */
export interface SystemOneWireRequest {
	state: ClassifierContext["state"];
	questions: Record<string, unknown>;
	assets?: Record<string, { type: "image"; format: "png" | "jpg"; data_base64: string }>;
}

/** Differences between services that serve System One models. */
export interface SystemOneTransport {
	/** Classifier API implemented by this transport. */
	api: ClassifierApi;
	/** Service name used in error messages. */
	label: string;
	/** Supports TypeSafe's image assets and Box questions. Other System One hosts opt in separately. */
	supportsImages?: boolean;
	/** Absolute request URL. */
	url(model: ClassifierModel<ClassifierApi>): URL;
	/** Wraps the System One request in the service's request envelope. */
	payload(model: ClassifierModel<ClassifierApi>, request: SystemOneWireRequest): unknown;
	/** Extracts the System One output (`{ answers, usage }`) from the service's response envelope. */
	output(body: unknown): Record<string, unknown>;
}

function probabilities(label: string, value: unknown, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([key, probability]) => [
			key,
			requiredNumber(label, probability, `probability for ${id}.${key}`),
		]),
	);
}

function parseBox(label: string, answer: Record<string, unknown>, id: string): ClassifierBoxAnswer {
	if (answer.type !== "box" || !isRecord(answer.box)) {
		throw new Error(`${label} did not return a box answer for ${id}`);
	}
	const fraction = (value: unknown, field: string): number => {
		const number = requiredNumber(label, value, `${field} for ${id}`);
		if (number < 0 || number > 1) throw new Error(`${label} returned an invalid ${field} for ${id}`);
		return number;
	};
	const box = {
		left: fraction(answer.box.left, "left"),
		top: fraction(answer.box.top, "top"),
		right: fraction(answer.box.right, "right"),
		bottom: fraction(answer.box.bottom, "bottom"),
	};
	if (box.left >= box.right || box.top >= box.bottom) {
		throw new Error(`${label} returned invalid box edges for ${id}`);
	}
	return { type: "box", box, confidence: fraction(answer.confidence, "confidence") };
}

function parseAnswers(label: string, value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	const answers: Array<[string, ClassifierAnswer]> = [];
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer.type !== "choice" || typeof answer.choice !== "string") {
				throw new Error(`${label} did not return a choice answer for ${id}`);
			}
			answers.push([
				id,
				{
					type: "choice",
					choice: answer.choice,
					probabilities: probabilities(label, answer.probabilities, id),
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else if (question.type === "score") {
			if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			answers.push([
				id,
				{
					type: "score",
					score: requiredNumber(label, answer.score, `score for ${id}`),
					confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
				},
			]);
		} else if (question.type === "box") {
			answers.push([id, parseBox(label, answer, id)]);
		} else {
			if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			answers.push([
				id,
				{
					type: "bool",
					probability: requiredNumber(label, answer.noul, `probability for ${id}`),
				},
			]);
		}
	}
	return Object.fromEntries(answers);
}

/** Maps public `bool` questions to TypeSafe's wire-level `noul` type. */
function wireRequest(label: string, context: ClassifierContext): SystemOneWireRequest {
	const request: SystemOneWireRequest = {
		state: context.state,
		questions: Object.fromEntries(
			Object.entries(context.questions).map(([id, question]) => [
				id,
				question.type === "bool" ? { ...question, type: "noul" } : question,
			]),
		),
	};
	if (context.images?.length) {
		if (Object.hasOwn(context.state, "images")) {
			throw new Error(`${label} image input reserves the state field images`);
		}
		const assets = context.images.map((image) => {
			const mimeType = image.mimeType.toLowerCase();
			const format =
				mimeType === "image/png" ? "png" : mimeType === "image/jpeg" || mimeType === "image/jpg" ? "jpg" : undefined;
			if (!format) throw new Error(`${label} only supports PNG and JPEG images, got ${image.mimeType}`);
			return [crypto.randomUUID(), { type: "image", format, data_base64: image.data }] as const;
		});
		request.assets = Object.fromEntries(assets);
		request.state = { ...context.state, images: assets.map(([reference]) => reference) };
	}
	return request;
}

/** Runs one System One classification over the given transport. */
export async function classifySystemOne(
	transport: SystemOneTransport,
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: ClassifierOptions | undefined,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		if (model.api !== transport.api) throw new Error(`Unsupported classifier API: ${model.api}`);
		const hasImages = Boolean(context.images?.length);
		const hasBox = Object.values(context.questions).some((question) => question.type === "box");
		if (hasImages) {
			if (!transport.supportsImages) throw new Error(`${transport.label} does not support image input`);
			if (!model.input.includes("image")) {
				throw new Error(`Model ${model.provider}/${model.id} does not accept image input`);
			}
		}
		if (hasBox) {
			if (!transport.supportsImages) throw new Error(`${transport.label} does not support box questions`);
			if (!hasImages) throw new Error(`${transport.label} box questions require image input`);
		}
		const requestOptions =
			hasImages || hasBox
				? {
						...options,
						headers: providerHeadersToRecord(options?.headers, { "TypeSafe-Danger-Zone-Images": "true" }),
					}
				: options;
		const body = await postClassifierRequest(
			transport.label,
			transport.url(model),
			model,
			transport.payload(model, wireRequest(transport.label, context)),
			requestOptions,
		);
		const result = transport.output(body);
		// Set before parsing answers: a request with malformed answers was still billed.
		const usage = parseClassifierUsage(result.usage, model);
		if (usage) output.usage = usage;
		output.answers = parseAnswers(transport.label, result.answers, context);
		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error), `${transport.label} error`);
		return output;
	}
}
