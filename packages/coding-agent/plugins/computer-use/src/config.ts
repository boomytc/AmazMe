import { defineDoc } from "@amazme/durable";

export const RISK_CATEGORIES = [
	"destructive",
	"send",
	"purchase",
	"close_unsaved",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export type ComputerUseSettings = {
	enabled: boolean;
	jevEnabled: boolean;
	jevProvider: string;
	jevModel: string;
	minPresence: number;
	minBoxConfidence: number;
	minChoiceConfidence: number;
	allowForeground: boolean;
	allowRiskCategories: RiskCategory[];
	timeoutMs: number;
};

export const DEFAULT_COMPUTER_USE_SETTINGS: Readonly<ComputerUseSettings> =
	Object.freeze({
		enabled: false,
		jevEnabled: true,
		jevProvider: "typesafe",
		jevModel: "jev-1.14.0",
		minPresence: 0.8,
		minBoxConfidence: 0.7,
		minChoiceConfidence: 0.7,
		allowForeground: false,
		allowRiskCategories: [],
		timeoutMs: 30_000,
	});

export const ComputerUsePolicy = defineDoc<ComputerUseSettings>({
	kind: "amazme.computer-use.policy",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({
		...DEFAULT_COMPUTER_USE_SETTINGS,
		allowRiskCategories: [],
	}),
});

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function probability(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

export function readComputerUseSettings(value: unknown): ComputerUseSettings {
	if (
		!isRecord(value) ||
		Object.keys(value).some(
			(key) => !Object.hasOwn(DEFAULT_COMPUTER_USE_SETTINGS, key),
		)
	)
		throw new Error("Unknown computer-use setting");
	for (const key of ["enabled", "jevEnabled", "allowForeground"])
		if (typeof value[key] !== "boolean")
			throw new Error(`${key} must be a boolean`);
	for (const key of ["jevProvider", "jevModel"])
		if (
			typeof value[key] !== "string" ||
			!value[key].trim() ||
			value[key].length > 200
		)
			throw new Error(`${key} must be a nonempty model identifier`);
	for (const key of ["minPresence", "minBoxConfidence", "minChoiceConfidence"])
		if (!probability(value[key]))
			throw new Error(`${key} must be between 0 and 1`);
	if (
		typeof value.timeoutMs !== "number" ||
		!Number.isSafeInteger(value.timeoutMs) ||
		value.timeoutMs < 100 ||
		value.timeoutMs > 300_000
	)
		throw new Error("timeoutMs must be an integer from 100 to 300000");
	if (
		!Array.isArray(value.allowRiskCategories) ||
		value.allowRiskCategories.some((risk) => !RISK_CATEGORIES.includes(risk)) ||
		new Set(value.allowRiskCategories).size !== value.allowRiskCategories.length
	)
		throw new Error(
			"allowRiskCategories must contain unique known risk categories",
		);
	return {
		...value,
		allowRiskCategories: [...value.allowRiskCategories],
	} as ComputerUseSettings;
}

export function editComputerUseSettings(
	current: ComputerUseSettings,
	args: string,
): ComputerUseSettings {
	const text = args.trim();
	if (text === "on" || text === "off")
		return readComputerUseSettings({ ...current, enabled: text === "on" });
	const patch: unknown = JSON.parse(text);
	if (!isRecord(patch))
		throw new Error("Computer-use settings must be a JSON object");
	return readComputerUseSettings({ ...current, ...patch });
}
