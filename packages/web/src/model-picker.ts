import type { Locale } from "./locale.ts";
import type { ModelOption, ModelPicker } from "./view.ts";
import { translate } from "./strings.ts";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const RECENT_KEY = "amazme.recent-models";
const RECENT_STORED = 6;
const RECENT_SHOWN = 4;
// A short catalog is already one glance; a recent section would only repeat it.
const RECENT_MIN_OPTIONS = 7;
const GAP_PX = 8;

type PickerIcon = "chevron-down" | "check" | "search" | "sliders";

function icon(name: PickerIcon, className: string): SVGSVGElement {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("class", `icon ${className}`);
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	const use = document.createElementNS(SVG_NAMESPACE, "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	return node;
}

function button(className: string): HTMLButtonElement {
	const node = element("button", className);
	node.type = "button";
	return node;
}

function optionKey(option: ModelOption): string {
	return JSON.stringify([option.provider, option.modelId]);
}

function readRecent(): string[] {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
		return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, RECENT_STORED) : [];
	} catch {
		// Storage is optional: a blocked or corrupt entry only loses the recent section.
		return [];
	}
}

function writeRecent(recent: readonly string[]): void {
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
	} catch {
		// Storage is optional: the choice still applies to the session.
	}
}

/**
 * One popover: search, the scoped catalog, the thinking levels, and the way to manage connections.
 * Shared by Web and the desktop page; changing model never changes the global default.
 */
export function createModelPicker(select: (provider: string, modelId: string) => void, think: (level: string) => void, manage: () => void) {
	const trigger = button("composer-model-picker");
	trigger.setAttribute("aria-haspopup", "dialog");
	trigger.setAttribute("aria-expanded", "false");
	const name = element("span", "composer-model-name");
	const effort = element("span", "composer-model-effort");
	effort.hidden = true;
	trigger.append(name, effort, icon("chevron-down", "composer-model-chevron"));

	const dialog = element("dialog", "model-picker-menu");
	const searchRow = element("label", "model-picker-search");
	const search = element("input", "");
	search.type = "search";
	search.autocomplete = "off";
	search.spellcheck = false;
	searchRow.append(icon("search", "model-picker-search-icon"), search);
	const notice = element("p", "model-picker-notice");
	notice.setAttribute("role", "status");
	notice.hidden = true;
	const list = element("div", "model-picker-list");
	const reasoning = element("div", "model-picker-reasoning");
	const reasoningLabel = element("span", "model-picker-section");
	const levels = element("div", "model-picker-levels");
	levels.setAttribute("role", "radiogroup");
	reasoning.append(reasoningLabel, levels);
	const configure = button("model-picker-manage");
	const configureLabel = element("span", "");
	configure.append(icon("sliders", "model-picker-manage-icon"), configureLabel);
	configure.addEventListener("click", () => { dialog.close(); manage(); });
	dialog.append(searchRow, notice, list, reasoning, configure);

	const root = element("div", "composer-model-control");
	root.append(trigger, dialog);
	let picker: ModelPicker | undefined;
	let locale: Locale = "en";
	let recent = readRecent();
	const copy = (key: Parameters<typeof translate>[1]) => translate(locale, key);

	// Anchor the bottom-right corner above the composer, so filtering grows and shrinks the list upward.
	const place = () => {
		const anchor = trigger.getBoundingClientRect();
		const ceiling = trigger.closest("form")?.getBoundingClientRect().top ?? anchor.top;
		const right = Math.max(GAP_PX, Math.min(window.innerWidth - anchor.right, window.innerWidth - dialog.offsetWidth - GAP_PX));
		dialog.style.right = `${Math.round(right)}px`;
		dialog.style.bottom = `${Math.round(window.innerHeight - ceiling + GAP_PX)}px`;
		dialog.style.maxHeight = `${Math.round(Math.max(160, ceiling - GAP_PX * 3))}px`;
	};

	const choose = (option: ModelOption) => {
		const key = optionKey(option);
		recent = [key, ...recent.filter(id => id !== key)].slice(0, RECENT_STORED);
		writeRecent(recent);
		dialog.close();
		select(option.provider, option.modelId);
	};

	const optionButton = (option: ModelOption, hint?: string) => {
		const control = button("model-picker-option");
		control.title = `${option.provider}/${option.modelId}`;
		control.setAttribute("aria-pressed", String(option.selected));
		const label = element("span", "model-picker-option-label");
		label.textContent = option.label;
		control.append(label);
		if (hint !== undefined) {
			const meta = element("span", "model-picker-option-hint");
			meta.textContent = hint;
			control.append(meta);
		}
		if (option.selected) control.append(icon("check", "model-picker-check"));
		control.addEventListener("click", () => choose(option));
		return control;
	};

	const heading = (text: string) => {
		const node = element("p", "model-picker-heading");
		node.textContent = text;
		return node;
	};

	const fillList = () => {
		list.replaceChildren();
		if (!picker) return;
		const query = search.value.trim().toLowerCase();
		const groups = picker.groups
			.map(group => ({ ...group, options: group.options.filter(option => `${option.label} ${option.provider} ${option.modelId}`.toLowerCase().includes(query)) }))
			.filter(group => group.options.length > 0);
		const all = groups.flatMap(group => group.options);
		if (!query && all.length >= RECENT_MIN_OPTIONS) {
			const recentOptions = recent.flatMap(id => all.filter(option => optionKey(option) === id)).slice(0, RECENT_SHOWN);
			if (recentOptions.length) list.append(heading(copy("model.recent")), ...recentOptions.map(option => optionButton(option, option.provider)));
		}
		for (const group of groups) list.append(heading(group.provider), ...group.options.map(option => optionButton(option)));
		// Enter in the search picks the first match; mark it so the key has a visible target.
		const first = query ? list.querySelector<HTMLButtonElement>(".model-picker-option") : null;
		if (first) first.dataset.active = "true";
		if (!groups.length) {
			const empty = element("p", "model-picker-empty");
			empty.textContent = query ? copy("model.noMatch") : picker.empty ?? copy("model.empty");
			list.append(empty);
		}
	};

	const selectLevel = (control: HTMLButtonElement, level: string) => {
		for (const other of levels.querySelectorAll("button")) {
			const on = other === control;
			other.setAttribute("aria-checked", String(on));
			other.tabIndex = on ? 0 : -1;
		}
		think(level);
	};

	const fillLevels = () => {
		levels.replaceChildren();
		reasoning.hidden = !picker || picker.levels.length < 2;
		if (reasoning.hidden || !picker) return;
		reasoningLabel.textContent = copy("model.effort");
		levels.setAttribute("aria-label", copy("model.effort"));
		for (const level of picker.levels) {
			const control = button("model-picker-level");
			control.textContent = level.label;
			control.setAttribute("role", "radio");
			control.setAttribute("aria-checked", String(level.selected));
			control.tabIndex = level.selected ? 0 : -1;
			control.addEventListener("click", () => selectLevel(control, level.level));
			levels.append(control);
		}
		if (!picker.levels.some(level => level.selected)) levels.querySelector("button")?.setAttribute("tabindex", "0");
	};

	const fill = () => {
		const scroll = list.scrollTop;
		const levelFocused = document.activeElement instanceof HTMLElement && document.activeElement.parentElement === levels;
		fillList();
		fillLevels();
		list.scrollTop = scroll;
		// A host update rebuilds the levels; keep the keyboard on the chosen one.
		if (levelFocused) levels.querySelector<HTMLButtonElement>("button[tabindex=\"0\"]")?.focus();
		if (dialog.open) place();
	};

	const options = () => [...list.querySelectorAll<HTMLButtonElement>(".model-picker-option")];

	search.addEventListener("input", () => { fill(); list.scrollTop = 0; });
	search.addEventListener("keydown", event => {
		if (event.key === "Enter") { event.preventDefault(); options()[0]?.click(); }
	});

	trigger.addEventListener("click", () => {
		if (dialog.open) { dialog.close(); return; }
		search.value = "";
		fill();
		// No frame is painted between showModal and place, so the default centered position never shows.
		dialog.showModal();
		place();
		list.querySelector<HTMLButtonElement>(".model-picker-option[aria-pressed=\"true\"]")?.scrollIntoView({ block: "nearest" });
		trigger.setAttribute("aria-expanded", "true");
		search.focus({ preventScroll: true });
	});
	dialog.addEventListener("close", () => { trigger.setAttribute("aria-expanded", "false"); trigger.focus({ preventScroll: true }); });
	dialog.addEventListener("pointerdown", event => {
		if (event.target !== dialog) return;
		const rect = dialog.getBoundingClientRect();
		const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
		if (!inside) dialog.close();
	});
	dialog.addEventListener("keydown", event => {
		const focused = document.activeElement;
		if (event.key === "Escape") {
			event.preventDefault();
			// The first Escape clears a filter, the next one closes.
			if (search.value) { search.value = ""; fill(); search.focus(); } else dialog.close();
			return;
		}
		if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && focused instanceof HTMLButtonElement && focused.parentElement === levels) {
			event.preventDefault();
			const controls = [...levels.querySelectorAll("button")];
			const next = controls[(controls.indexOf(focused) + (event.key === "ArrowRight" ? 1 : controls.length - 1)) % controls.length];
			next?.focus();
			next?.click();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const rows = options();
		const index = focused instanceof HTMLButtonElement ? rows.indexOf(focused) : -1;
		const down = event.key === "ArrowDown";
		if (index < 0) { (down ? rows[0] : rows.at(-1))?.focus(); return; }
		const next = index + (down ? 1 : -1);
		if (next < 0 || next >= rows.length) search.focus();
		else rows[next]?.focus();
	});

	return { element: root, update(nextLocale: Locale, value: ModelPicker, disabled = false) {
		locale = nextLocale; picker = value;
		name.textContent = value.label;
		notice.textContent = value.scopeNotice ?? "";
		notice.hidden = !value.scopeNotice;
		trigger.title = value.scopeNotice ?? value.label;
		effort.textContent = value.effort ?? "";
		effort.hidden = !value.effort;
		trigger.disabled = value.disabled || disabled;
		trigger.setAttribute("aria-label", `${copy("model.heading")}: ${[value.label, value.effort].filter(Boolean).join(", ")}`);
		dialog.setAttribute("aria-label", copy("model.choose"));
		search.placeholder = copy("model.search");
		search.setAttribute("aria-label", search.placeholder);
		configureLabel.textContent = copy("connections.manage");
		if (dialog.open) { if (trigger.disabled) dialog.close(); else fill(); }
	} };
}
