import type { Locale } from "./locale.ts";
import type { ModelPicker } from "./view.ts";
import { translate } from "./strings.ts";

/** Shared by Web and the desktop page; changing model never changes the global default. */
export function createModelPicker(select: (provider: string, modelId: string) => void, think: (level: string) => void, manage: () => void) {
	const trigger = document.createElement("button"); trigger.type = "button"; trigger.className = "composer-model-picker";
	trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
	const dialog = document.createElement("dialog"); dialog.className = "model-picker-menu";
	const search = document.createElement("input"); search.type = "search";
	const list = document.createElement("div"); list.className = "model-picker-list";
	const reasoning = document.createElement("div"); reasoning.className = "model-picker-reasoning";
	const configure = document.createElement("button"); configure.type = "button"; configure.className = "model-picker-manage";
	configure.addEventListener("click", () => { dialog.close(); manage(); });
	dialog.append(search, list, reasoning, configure);
	const root = document.createElement("div"); root.className = "composer-model-control"; root.append(trigger, dialog);
	let picker: ModelPicker | undefined;
	let locale: Locale = "en";
	let recent: string[] = [];
	try { const stored: unknown = JSON.parse(localStorage.getItem("amazme.recent-models") ?? "[]"); if (Array.isArray(stored)) recent = stored.filter((id): id is string => typeof id === "string").slice(0, 6); } catch { /* Storage is optional. */ }
	const copy = (key: Parameters<typeof translate>[1]) => translate(locale, key);
	const fill = () => {
		list.replaceChildren(); reasoning.replaceChildren();
		if (!picker) return;
		const query = search.value.trim().toLowerCase();
		const groups = picker.groups.map(group => ({ ...group, options: group.options.filter(option => `${option.label} ${option.provider} ${option.modelId}`.toLowerCase().includes(query)) })).filter(group => group.options.length);
		const addOption = (option: ModelPicker["groups"][number]["options"][number]) => {
			const control = document.createElement("button"); control.type = "button"; control.className = "model-picker-option";
			control.textContent = `${option.label}${option.selected ? " ✓" : ""}`; control.title = `${option.provider}/${option.modelId}`;
			control.setAttribute("aria-pressed", String(option.selected));
			control.addEventListener("click", () => {
				const key = JSON.stringify([option.provider, option.modelId]); recent = [key, ...recent.filter(id => id !== key)].slice(0, 6);
				try { localStorage.setItem("amazme.recent-models", JSON.stringify(recent)); } catch { /* Storage is optional. */ }
				dialog.close(); select(option.provider, option.modelId);
			}); return control;
		};
		const recentOptions = recent.flatMap(id => groups.flatMap(group => group.options.filter(option => JSON.stringify([option.provider, option.modelId]) === id)));
		if (!query && recentOptions.length) {
			const heading = document.createElement("p"); heading.textContent = copy("model.recent"); list.append(heading, ...recentOptions.map(addOption));
		}
		for (const group of groups) {
			const heading = document.createElement("p"); heading.textContent = group.provider; list.append(heading, ...group.options.map(addOption));
		}
		if (!groups.length) { const empty = document.createElement("p"); empty.textContent = query ? copy("model.noMatch") : picker.empty ?? copy("model.empty"); list.append(empty); }
		if (picker.levels.length > 1) {
			const label = document.createElement("p"); label.textContent = copy("model.effort"); reasoning.append(label);
			for (const level of picker.levels) {
				const control = document.createElement("button"); control.type = "button"; control.textContent = level.label;
				control.setAttribute("aria-pressed", String(level.selected));
				control.addEventListener("click", () => { dialog.close(); think(level.level); }); reasoning.append(control);
			}
		}
	};
	search.addEventListener("input", fill);
	trigger.addEventListener("click", () => {
		search.value = ""; fill(); dialog.showModal();
		const rect = trigger.getBoundingClientRect();
		dialog.style.left = `${Math.max(8, Math.min(rect.right - dialog.offsetWidth, window.innerWidth - dialog.offsetWidth - 8))}px`;
		dialog.style.top = `${Math.max(8, rect.top - dialog.offsetHeight - 8)}px`;
		trigger.setAttribute("aria-expanded", "true"); search.focus();
	});
	dialog.addEventListener("close", () => { trigger.setAttribute("aria-expanded", "false"); trigger.focus(); });
	dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
	dialog.addEventListener("keydown", event => {
		if (event.key === "Escape") { event.preventDefault(); dialog.close(); return; }
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const controls = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
		const index = controls.findIndex(control => control === document.activeElement);
		const next = index < 0 ? (event.key === "ArrowDown" ? 0 : controls.length - 1) : (index + (event.key === "ArrowDown" ? 1 : controls.length - 1)) % controls.length;
		controls[next]?.focus();
	});
	return { element: root, update(nextLocale: Locale, value: ModelPicker, disabled = false) {
		locale = nextLocale; picker = value;
		trigger.textContent = [value.label, value.effort, "⌄"].filter(Boolean).join(" · ");
		trigger.disabled = value.disabled || disabled;
		trigger.setAttribute("aria-label", `${copy("model.heading")}: ${value.label}`);
		dialog.setAttribute("aria-label", copy("model.choose")); search.placeholder = copy("model.search"); search.setAttribute("aria-label", search.placeholder);
		configure.textContent = copy("connections.manage");
		if (dialog.open) { if (trigger.disabled) dialog.close(); else fill(); }
	} };
}
