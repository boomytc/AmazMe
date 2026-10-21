import type { MessageKey } from "./strings.ts";

interface ReadingOptions {
	readonly copy: (key: MessageKey, values?: Record<string, string>) => string;
	readonly copyText: (control: HTMLButtonElement, text: string, label: MessageKey) => void;
	readonly icon: (name: "wrap") => SVGSVGElement;
	readonly preservePosition: (root: HTMLElement) => () => void;
}
interface Reader {
	readonly key: string;
	readonly root: HTMLElement;
	readonly content: HTMLElement;
	readonly toolbar: HTMLElement;
	readonly text: string;
	/** Omitted when the surface already shows the text and has no separate copy action. */
	readonly copyLabel?: MessageKey;
	readonly lineCount?: number;
	readonly fold?: boolean;
}

/** Reading preferences only; copied values and line limits remain owned by each content producer. */
export function createReadingControls(options: ReadingOptions) {
	const states = new Map<string, { wrap: boolean; expanded: boolean; id: number }>();
	let nextId = 0;
	const attach = (reader: Reader): void => {
		const { root, content, toolbar } = reader;
		let state = states.get(reader.key);
		if (!state) {
			state = { wrap: false, expanded: false, id: nextId++ };
			states.set(reader.key, state);
		}
		const preference = state;
		root.classList.add("text-reader");
		content.classList.add("reader-content");
		content.tabIndex = 0;
		// DOM identities must not expose content-bearing preference keys.
		content.dataset.controlKey = `reader:${preference.id}:content`;
		toolbar.classList.add("reader-controls");
		const control = (label: MessageKey, className: string): HTMLButtonElement => {
			const node = document.createElement("button");
			node.type = "button";
			node.className = `reader-button ${className}`;
			node.dataset.controlKey = `reader:${preference.id}:${className}`;
			node.textContent = options.copy(label);
			node.title = options.copy(label);
			node.setAttribute("aria-label", options.copy(label));
			return node;
		};
		const wrap = control("dock.wrapLines", "reader-wrap");
		wrap.replaceChildren(options.icon("wrap"));
		const syncWrap = (): void => {
			content.classList.toggle("wrap", preference.wrap);
			wrap.setAttribute("aria-pressed", String(preference.wrap));
		};
		wrap.addEventListener("click", () => {
			const restore = options.preservePosition(root);
			preference.wrap = !preference.wrap;
			syncWrap();
			restore();
		});
		syncWrap();
		toolbar.append(wrap);
		const count = reader.lineCount ?? (reader.text.length === 0 ? 0 : reader.text.replace(/\n$/, "").split("\n").length);
		if (reader.fold !== false && count > 24) {
			const head = control("code.collapse", "reader-fold code-fold");
			const foot = control("code.collapse", "reader-expand-bar code-expand-bar");
			const syncFold = (): void => {
				root.classList.toggle("collapsed", !preference.expanded);
				root.dataset.collapsed = String(!preference.expanded);
				const label = options.copy(preference.expanded ? "code.collapse" : "code.expand", { count: String(count) });
				for (const node of [head, foot]) {
					node.textContent = label;
					node.title = label;
					node.setAttribute("aria-label", label);
					node.setAttribute("aria-expanded", String(preference.expanded));
				}
			};
			const toggle = (): void => {
				const restore = options.preservePosition(root);
				preference.expanded = !preference.expanded;
				syncFold();
				restore();
			};
			head.addEventListener("click", toggle);
			foot.addEventListener("click", toggle);
			toolbar.append(head);
			root.append(foot);
			syncFold();
		}
		if (reader.copyLabel !== undefined) {
			const label = reader.copyLabel;
			const copy = control(label, "reader-copy");
			copy.dataset.copyLabel = "visible";
			copy.addEventListener("click", () => options.copyText(copy, reader.text, label));
			toolbar.append(copy);
		}
	};
	return { attach, clear: () => states.clear() };
}

export type ReadingControls = ReturnType<typeof createReadingControls>;
