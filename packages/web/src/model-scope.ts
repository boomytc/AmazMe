import { MODEL_SCOPE_MODAL } from "./actions.ts";
import type { Locale } from "./locale.ts";
import type { PanelModal } from "./panels.ts";
import { translate } from "./strings.ts";

export interface ModelScopeLike {
	readonly allModels: readonly {
		readonly provider: string;
		readonly id: string;
		readonly name: string;
	}[];
	readonly enabledModelIds: readonly string[] | null;
}

/** The same host scope that the terminal configures, presented as checkboxes. */
export function modelScopeModal(
	locale: Locale,
	scope: ModelScopeLike,
): PanelModal {
	const options = scope.allModels.map((model) => ({
		value: `${model.provider}/${model.id}`,
		label: `${model.name} · ${model.provider}/${model.id}`,
	}));
	for (const id of scope.enabledModelIds ?? [])
		if (!options.some((option) => option.value === id))
			options.push({
				value: id,
				label: translate(locale, "model.scopeUnavailable", { id }),
			});
	return {
		id: MODEL_SCOPE_MODAL,
		title: translate(locale, "model.scope"),
		description: translate(locale, "model.scopeHelp"),
		fields: [
			{
				id: "models",
				label: translate(locale, "model.scopeList"),
				kind: "multiselect",
				options,
				value: JSON.stringify(scope.enabledModelIds),
			},
			{
				id: "persist",
				label: translate(locale, "model.scopePersist"),
				kind: "checkbox",
				value: "false",
			},
		],
		submit: translate(locale, "model.scopeApply"),
	};
}
