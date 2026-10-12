import type { PanelButton, PanelPending, PanelSpec, PanelText } from "./panels.ts";
import type { MessageKey } from "./strings.ts";
import { WORKSPACE_OPEN_ACTION } from "./actions.ts";

type FileGlyph = "search" | "x" | "copy";
interface FileBrowserOptions {
	readonly icon: (name: FileGlyph, className?: string) => SVGSVGElement;
	readonly copy: (key: MessageKey, values?: Record<string, string>) => string;
	readonly actionButton: (action: PanelButton, pending?: PanelPending) => HTMLButtonElement;
	readonly headerAction: (button: HTMLButtonElement, label: string, glyph: "copy" | "x") => void;
	readonly copyText: (button: HTMLButtonElement, text: string, label: MessageKey) => void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}
function button(className: string): HTMLButtonElement {
	const node = element("button", className);
	node.type = "button";
	return node;
}

/** Page-local filtering and reading preferences; paths and contents always come from the host. */
export function createFileBrowser(options: FileBrowserOptions) {
	const { icon, copy, actionButton: panelButton, headerAction: placeHeaderAction, copyText: copyAnswer } = options;
	let fileFilter = { scope: "", query: "" };
	let sourceWrap = false;
	const fileNavigation = (panel: PanelSpec, node: HTMLElement, sessionId: string): HTMLElement => {
		const files = panel.files!;
		const busy = panel.pending?.id.startsWith("workspace:") === true;
		node.setAttribute("aria-busy", String(busy));
		if (busy) for (const control of node.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".file-entry, [data-action^='workspace:'], [data-group-id='files:workspaces'] select")) control.disabled = true;
		const navigation = element("div", "file-navigation");
		const trail = element("nav", "file-breadcrumbs");
		trail.setAttribute("aria-label", copy("dock.filePath"));
		for (const [index, crumb] of files.breadcrumbs.entries()) {
			if (index > 0) trail.append(element("span", "file-path-separator", "/"));
			const step = crumb.current ? element("span", "file-crumb current", crumb.label) : panelButton({ id: WORKSPACE_OPEN_ACTION, label: crumb.label, tone: "default", data: crumb.path }, panel.pending);
			step.classList.add("file-crumb");
			step.title = crumb.path;
			if (crumb.current) step.setAttribute("aria-current", "page");
			else {
				step.dataset.controlKey = `file-crumb:${crumb.path}`;
				(step as HTMLButtonElement).disabled = busy;
			}
			trail.append(step);
		}
		const copyPath = button("file-icon-button");
		placeHeaderAction(copyPath, copy("dock.copyPath"), "copy");
		copyPath.addEventListener("click", () => copyAnswer(copyPath, files.breadcrumbs.at(-1)?.path ?? files.cwd, "dock.copyPath"));
		navigation.append(trail, copyPath);
		if (files.filterScope !== undefined) {
			const scope = `${sessionId}:${files.filterScope}`;
			if (fileFilter.scope !== scope) fileFilter = { scope, query: "" };
			const filter = element("div", "file-filter");
			const field = document.createElement("input");
			field.type = "search";
			field.className = "file-filter-input";
			field.placeholder = copy("dock.filterFiles");
			field.setAttribute("aria-label", copy("dock.filterFiles"));
			field.autocomplete = "off";
			field.spellcheck = false;
			field.value = fileFilter.query;
			field.dataset.controlKey = `file-filter:${scope}`;
			const clear = button("file-icon-button");
			placeHeaderAction(clear, copy("dock.clearFilter"), "x");
			const status = element("p", "file-filter-status");
			status.setAttribute("role", "status");
			const empty = element("p", "panel-empty file-filter-empty", copy("dock.noMatchingFiles"));
			const apply = (): void => {
				fileFilter.query = field.value;
				const query = field.value.trim().toLocaleLowerCase();
				let count = 0;
				for (const entry of node.querySelectorAll<HTMLButtonElement>(".file-entry:not(.file-entry-up)")) {
					entry.hidden = !(entry.dataset.fileName ?? "").toLocaleLowerCase().includes(query);
					if (!entry.hidden) count += 1;
				}
				clear.hidden = field.value.length === 0;
				status.hidden = query.length === 0;
				status.textContent = copy("dock.matchingFiles", { count: String(count) });
				empty.hidden = query.length === 0 || count > 0;
				for (const message of node.querySelectorAll<HTMLElement>(".file-entries > .panel-empty:not(.file-filter-empty)")) message.hidden = query.length > 0;
			};
			field.addEventListener("input", apply);
			const reset = () => { field.value = ""; apply(); field.focus(); };
			clear.addEventListener("click", reset);
			field.addEventListener("keydown", event => {
				if (event.isComposing) return;
				if (event.key === "Escape" && field.value.length > 0) { event.preventDefault(); event.stopPropagation(); reset(); }
				if (event.key === "ArrowDown") { event.preventDefault(); node.querySelector<HTMLButtonElement>(".file-entry:not(.file-entry-up):not([hidden]):not(:disabled)")?.focus(); }
			});
			filter.append(icon("search"), field, clear);
			navigation.append(filter, status);
			const entries = node.querySelector('[data-group-id="files:entries"] .panel-rows');
			entries?.append(empty);
			apply();
		}
		if (busy) {
			const status = element("p", "file-operation-status", copy("dock.readingFiles"));
			status.setAttribute("role", "status");
			navigation.append(status);
		}
		return navigation;
	};

	/** One text block: a file's content or a terminal's output, kept as text. */
	const textElement = (text: PanelText): HTMLElement => {
		const block = element("div", "panel-text-block");
		if (text.title !== undefined) block.append(element("p", "panel-text-title", text.title));
		if (text.text.length === 0 && text.empty !== undefined) {
			block.append(element("p", "panel-empty", text.empty));
			return block;
		}
		if (text.source) {
			block.classList.add("file-source");
			const all = text.text.length === 0 ? [] : text.text.split("\n");
			if (all.at(-1) === "") all.pop();
			// Byte-bounded files can still contain hundreds of thousands of empty lines.
			const lines = all.slice(0, 2000);
			const displayed = all.length > lines.length ? lines.join("\n") : text.text;
			const toolbar = element("div", "file-source-toolbar");
			toolbar.append(element("span", "file-source-caption", copy("dock.sourceLines", { count: String(lines.length) })));
			const wrap = button("file-icon-button file-wrap-button");
			wrap.textContent = "Aa";
			wrap.title = copy("dock.wrapLines");
			wrap.setAttribute("aria-label", copy("dock.wrapLines"));
			wrap.setAttribute("aria-pressed", String(sourceWrap));
			const copyContents = button("file-icon-button");
			placeHeaderAction(copyContents, copy("dock.copyContents"), "copy");
			copyContents.addEventListener("click", () => copyAnswer(copyContents, displayed, "dock.copyContents"));
			toolbar.append(wrap, copyContents);
			block.append(toolbar);
			if (all.length > lines.length) block.append(element("p", "panel-notice info", copy("dock.sourceLimited", { count: String(lines.length) })));
			const source = element("div", `file-source-code${sourceWrap ? " wrap" : ""}`);
			source.tabIndex = 0;
			source.setAttribute("role", "region");
			source.setAttribute("aria-label", copy("dock.contents"));
			for (const [index, line] of lines.entries()) {
				const row = element("div", "file-source-line");
				const number = element("span", "file-line-number", String(index + 1));
				number.setAttribute("aria-hidden", "true");
				row.append(number, element("code", "file-line-code", line.replace(/\r$/, "") || "\u200b"));
				source.append(row);
			}
			if (lines.length === 0) source.append(element("p", "panel-empty", copy("dock.emptyFile")));
			wrap.addEventListener("click", () => { sourceWrap = !sourceWrap; source.classList.toggle("wrap", sourceWrap); wrap.setAttribute("aria-pressed", String(sourceWrap)); });
			block.append(source);
		} else block.append(element("pre", "panel-text", text.text));
		return block;
	};

	return { navigation: fileNavigation, text: textElement };
}
