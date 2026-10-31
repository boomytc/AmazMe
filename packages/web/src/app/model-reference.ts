import type { ModelSelection } from "../generated/contracts.ts";
import { parseContract } from "../transport/api.ts";

export function modelReference(value: string): ModelSelection {
	const selected: unknown = JSON.parse(value);
	if (!Array.isArray(selected) || selected.length !== 2)
		throw new Error("模型选择无效");
	return parseContract("ModelSelection", {
		provider: selected[0],
		model: selected[1],
	});
}
