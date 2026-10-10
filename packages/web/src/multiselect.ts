import type { Locale } from "./locale.ts";
import type { PanelField } from "./panels.ts";
import { translate } from "./strings.ts";

/** A searchable checkbox field; its hidden input remains the modal's single submitted value. */
export function createMultiselect(
	field: PanelField,
	locale: Locale,
): {
	readonly body: HTMLDivElement;
	readonly value: HTMLInputElement;
	readonly focus: HTMLInputElement;
} {
	const options = field.options ?? [];
	const parsed: unknown = JSON.parse(field.value);
	if (
		parsed !== null &&
		(!Array.isArray(parsed) ||
			parsed.some((value: unknown) => typeof value !== "string"))
	)
		throw new Error("Invalid checkbox selection");
	let selected = parsed === null ? null : new Set<string>(parsed as string[]);
	const body = document.createElement("div");
	body.className = "modal-multiselect";
	const value = document.createElement("input");
	value.type = "hidden";
	const search = document.createElement("input");
	search.type = "search";
	search.className = "modal-input";
	search.placeholder = translate(locale, "model.search");
	search.setAttribute("aria-label", search.placeholder);
	const controls = document.createElement("div");
	controls.className = "multiselect-controls";
	const all = document.createElement("button");
	all.type = "button";
	all.className = "panel-button default";
	const clear = all.cloneNode() as HTMLButtonElement;
	const count = document.createElement("span");
	count.className = "multiselect-count";
	controls.append(all, clear, count);
	const list = document.createElement("div");
	list.className = "multiselect-options";
	const rows = options.map((option) => {
		const label = document.createElement("label");
		label.className = "multiselect-option";
		const input = document.createElement("input");
		input.type = "checkbox";
		input.value = option.value;
		const text = document.createElement("span");
		text.textContent = option.label;
		label.append(input, text);
		list.append(label);
		input.addEventListener("change", () => {
			const next = new Set(selected ?? options.map((item) => item.value));
			if (input.checked) next.add(option.value);
			else next.delete(option.value);
			selected =
				options.length > 0 &&
				options.every((item) => next.has(item.value)) &&
				next.size === options.length
					? null
					: next;
			update();
		});
		return { option, label, input };
	});
	const empty = document.createElement("p");
	empty.className = "menu-empty";
	empty.textContent = translate(locale, "model.noMatches");
	list.append(empty);
	const update = (): void => {
		const query = search.value.trim().toLocaleLowerCase();
		for (const row of rows) {
			row.input.checked = selected === null || selected.has(row.option.value);
			row.label.hidden =
				query.length > 0 &&
				!`${row.option.label} ${row.option.value}`
					.toLocaleLowerCase()
					.includes(query);
		}
		all.textContent = translate(
			locale,
			query ? "model.selectMatches" : "model.selectAll",
		);
		clear.textContent = translate(
			locale,
			query ? "model.clearMatches" : "model.clearAll",
		);
		count.textContent = translate(locale, "model.selectedCount", {
			selected: String(selected?.size ?? options.length),
			total: String(options.length),
		});
		empty.hidden = rows.some((row) => !row.label.hidden);
		value.value = JSON.stringify(selected === null ? null : [...selected]);
	};
	const selectVisible = (enabled: boolean): void => {
		if (!search.value.trim()) selected = enabled ? null : new Set();
		else {
			const next = new Set(selected ?? options.map((option) => option.value));
			for (const row of rows)
				if (!row.label.hidden) {
					if (enabled) next.add(row.option.value);
					else next.delete(row.option.value);
				}
			selected = next;
		}
		update();
	};
	all.addEventListener("click", () => selectVisible(true));
	clear.addEventListener("click", () => selectVisible(false));
	search.addEventListener("input", update);
	body.append(search, controls, list, value);
	update();
	return { body, value, focus: search };
}
