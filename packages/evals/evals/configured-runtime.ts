import type { JsonValue } from "@vitest-evals/core";
import { z } from "zod";
import type { NativeEvalResult } from "../src/harness.ts";
const ProbeSchema = z.object({
	response: z.string(),
	existing_models_preserved: z.boolean(),
	settings: z.object({
		provider: z.string(),
		model: z.string(),
		api: z.string(),
		max_tokens: z.number(),
		key_configured: z.boolean(),
	}),
});
export function configuredProvider(result: NativeEvalResult, validRequestReceived: boolean): Record<string, JsonValue> {
	const parsed = ProbeSchema.safeParse(result.evidence.provider_probe);
	if (!parsed.success) return { error: result.errors.join(",") || "provider_probe_missing" };
	return { ...parsed.data, validRequestReceived };
}
