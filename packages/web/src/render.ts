/// <reference lib="dom" />
/**
 * Thin DOM renderer: it turns the pure view model into the page's shell markup and owns no
 * business state of its own. Every update rebuilds the flow, then restores the transcript's
 * scroll position so streaming does not yank the reader around. The one thing kept between
 * updates is the reader's own disclosure choices, keyed by block id, because a rebuild would
 * otherwise reset them.
 */
import { composerPlaceholder, type TranscriptBlock, type WebView } from "./view.ts";

export interface PageElements {
	readonly connection: HTMLElement;
	readonly mode: HTMLElement;
	readonly sessionTitle: HTMLElement;
	readonly roster: HTMLElement;
	readonly transcript: HTMLElement;
	readonly column: HTMLElement;
	readonly queue: HTMLElement;
	readonly composer: HTMLFormElement;
	readonly prompt: HTMLTextAreaElement;
	/** The composer's one action: send, or stop while a turn runs on an empty draft. */
	readonly primary: HTMLButtonElement;
}

export interface PageRenderer {
	render(view: WebView): void;
	setConnection(text: string, kind: "state" | "error"): void;
	/** Handlers the page entry fills in once it can drive the host. */
	onSelect: (sessionId: string) => void;
	onSubmit: (text: string) => void;
	onAbort: () => void;
	/** The view the composer's enabled state and placeholder were last rendered from. */
	readonly view: WebView | undefined;
}

export function collectPageElements(): PageElements {
	return {
		connection: pick("connection"),
		mode: pick("mode"),
		sessionTitle: pick("session-title"),
		roster: pick("roster"),
		transcript: pick("transcript"),
		column: pick("column"),
		queue: pick("queue"),
		composer: pickElement("composer", HTMLFormElement),
		prompt: pickElement("prompt", HTMLTextAreaElement),
		primary: pickElement("primary", HTMLButtonElement),
	};
}

function pick(id: string): HTMLElement {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`Page document is missing #${id}`);
	return found;
}

function pickElement<T extends HTMLElement>(id: string, constructor: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof constructor)) throw new Error(`Page document is missing #${id}`);
	return found;
}

function element(tag: string, className: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(className: string): HTMLButtonElement {
	const node = document.createElement("button");
	node.type = "button";
	node.className = className;
	return node;
}

/** One flow item: a classed group around a single child. */
function wrap(className: string, child: HTMLElement): HTMLElement {
	const group = element("div", className);
	group.append(child);
	return group;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The primary action's glyph: an arrow to send, a rounded square to stop (InputBar's icon slots). */
function primaryGlyph(stop: boolean): SVGSVGElement {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("aria-hidden", "true");
	const shape = document.createElementNS(SVG_NAMESPACE, stop ? "rect" : "path");
	shape.setAttribute("fill", stop ? "currentColor" : "none");
	if (stop) {
		shape.setAttribute("x", "3");
		shape.setAttribute("y", "3");
		shape.setAttribute("width", "10");
		shape.setAttribute("height", "10");
		shape.setAttribute("rx", "3");
	} else {
		shape.setAttribute("d", "M8 13.4V3.4M3.6 7.4 8 3l4.4 4.4");
		shape.setAttribute("stroke", "currentColor");
		shape.setAttribute("stroke-width", "1.8");
		shape.setAttribute("stroke-linecap", "round");
		shape.setAttribute("stroke-linejoin", "round");
	}
	svg.append(shape);
	return svg;
}

/** The leading 16px glyph box every disclosure row and notice row carries. */
function leading(): HTMLElement {
	return element("span", "disclosure-leading");
}

/** A row's one-line summary: the first non-empty line of a longer text. */
function firstLine(text: string): string {
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0);
	return line?.trim() ?? "";
}

function atBottom(target: HTMLElement): boolean {
	return target.scrollHeight - target.scrollTop - target.clientHeight < 24;
}

function fitPrompt(prompt: HTMLTextAreaElement): void {
	prompt.style.height = "auto";
	// The draft grows with its content; the sheet caps it at `--dsh-composer-text-max-height` and
	// the box scrolls once it is capped.
	prompt.style.height = `${prompt.scrollHeight}px`;
}

export function createRenderer(
	elements: PageElements,
	onSelect: (sessionId: string) => void = () => {},
): PageRenderer {
	let lastView: WebView | undefined;
	/** Reader disclosure choices, keyed by block id so a rebuild keeps them. */
	const expanded = new Map<TranscriptBlock["id"], boolean>();
	/** The primary action's current role, so the glyph is only rebuilt when it flips. */
	let stops = false;

	const draft = (): string => elements.prompt.value.trim();

	/**
	 * The primary action is Stop while a turn runs on an empty draft, and Send otherwise — the same
	 * rule InputBar uses — and Send is disabled with nothing to send.
	 */
	const renderPrimary = (): void => {
		const stop = lastView?.busy === true && draft().length === 0;
		if (stop !== stops) {
			stops = stop;
			elements.primary.replaceChildren(primaryGlyph(stop));
			const label = stop ? "Stop" : "Send";
			elements.primary.setAttribute("aria-label", label);
			elements.primary.title = label;
		}
		elements.primary.disabled = lastView?.attachedId === undefined || (!stop && draft().length === 0);
	};

	/** A disclosure whose open state is the reader's, falling back to a per-block default. */
	const disclosure = (block: TranscriptBlock, className: string, defaultOpen: boolean): HTMLDetailsElement => {
		const details = document.createElement("details");
		details.className = `disclosure ${className}`.trim();
		details.open = expanded.get(block.id) ?? defaultOpen;
		// The click handler runs before the browser toggles, so the intent is the flipped value.
		details.addEventListener("click", () => expanded.set(block.id, !details.open));
		return details;
	};

	/** A row: the leading glyph, the title, and — when a summary is given — the dot and one line of it. */
	const rowElement = (block: TranscriptBlock, tag: "summary" | "div", summary?: string): HTMLElement => {
		const line = element(tag, "disclosure-row");
		line.append(leading(), element("span", "disclosure-title", block.title));
		if (summary !== undefined && summary.length > 0) {
			line.append(element("span", "disclosure-sep"), element("span", "disclosure-summary", summary));
		}
		return line;
	};

	/** A settled or running tool call: DSH shows a running row open and collapses a settled one. */
	const toolElement = (block: TranscriptBlock): HTMLElement => {
		const tone = block.running ? "running" : block.tone === "error" ? "error" : "";
		const details = disclosure(block, tone, block.running);
		details.append(rowElement(block, "summary", firstLine(block.text)));
		if (block.text.length > 0) {
			details.append(element("div", "tool-output", block.text));
		} else if (!block.running) {
			details.append(element("div", "tool-output empty", "(no output)"));
		}
		return details;
	};

	/** Assistant reasoning: the Think row, collapsed until the reader opens it. */
	const reasoningElement = (block: TranscriptBlock): HTMLElement => {
		const details = disclosure(block, "", false);
		details.append(rowElement(block, "summary"), element("div", "reasoning-body", block.text));
		return details;
	};

	/** A flow notice (compaction, new context): one 24px row, with its summary indented below. */
	const noticeElement = (block: TranscriptBlock): HTMLElement => {
		const group = element("div", "disclosure");
		group.append(rowElement(block, "div"));
		if (block.text.length > 0) group.append(element("div", "notice-body", block.text));
		return group;
	};

	/** A failed turn: a status dot, the failure's title, and its message. */
	const errorElement = (block: TranscriptBlock): HTMLElement => {
		const line = element("div", "error-row");
		const copy = element("div", "error-copy");
		copy.append(element("span", "error-title", block.title), element("span", "error-message", block.text));
		line.append(element("span", "error-dot"), copy);
		return line;
	};

	/** The live status line (DSH's ChatView `.running`), the flow's last item while a turn runs. */
	const runningElement = (status: string): HTMLElement => {
		const line = element("div", "running");
		line.append(element("span", "running-text", status));
		return line;
	};

	const isProcess = (block: TranscriptBlock): boolean => block.kind === "thinking" || block.kind === "tool";

	/** The flow: user and assistant turns, one group per run of process rows, notices, the status. */
	const flowElements = (view: WebView): HTMLElement[] => {
		const flow: HTMLElement[] = [];
		let process: HTMLElement | undefined;
		for (const block of view.blocks) {
			if (isProcess(block)) {
				if (process === undefined) {
					process = element("div", "turn-process");
					flow.push(process);
				}
				process.append(block.kind === "tool" ? toolElement(block) : reasoningElement(block));
				continue;
			}
			process = undefined;
			if (block.kind === "user") flow.push(wrap("turn-user", element("div", "bubble", block.text)));
			else if (block.kind === "assistant") flow.push(element("div", "turn-response", block.text));
			else if (block.kind === "notice") flow.push(block.tone === "error" ? errorElement(block) : noticeElement(block));
		}
		return flow;
	};

	const renderer: PageRenderer = {
		onSelect,
		onSubmit: () => {},
		onAbort: () => {},
		get view(): WebView | undefined {
			return lastView;
		},
		render(view: WebView): void {
			lastView = view;
			const stick = atBottom(elements.transcript);

			elements.roster.replaceChildren();
			for (const item of view.roster) {
				const chip = button(item.attached ? "session-row attached" : "session-row");
				chip.dataset.sessionId = item.id;
				chip.append(element("span", "session-name", item.label));
				const age = element("time", "session-age", item.age);
				age.setAttribute("datetime", item.ageIso);
				chip.append(age);
				chip.addEventListener("click", () => renderer.onSelect(item.id));
				elements.roster.append(chip);
			}
			if (view.roster.length === 0) {
				const empty = element("p", "empty-state", view.empty ?? "No sessions on this host yet.");
				empty.id = "roster-empty";
				elements.roster.append(empty);
			}

			const flow = flowElements(view);
			if (view.blocks.length === 0) {
				const empty = element(
					"p",
					"empty-state",
					view.attachedId === undefined ? "No session attached." : "No entries in this session yet.",
				);
				empty.id = "transcript-empty";
				flow.push(empty);
			}
			if (view.status.length > 0) flow.push(runningElement(view.status));
			elements.column.replaceChildren(...flow);
			if (stick) elements.transcript.scrollTop = elements.transcript.scrollHeight;

			elements.sessionTitle.textContent = view.attachedId ?? "No session";

			const detached = view.attachedId === undefined;
			elements.prompt.disabled = detached;
			elements.prompt.placeholder = composerPlaceholder(view.attachedId);
			renderPrimary();

			elements.queue.replaceChildren();
			for (const item of view.queue) elements.queue.append(element("p", "queue-item", item));
		},
		setConnection(text: string, kind: "state" | "error"): void {
			elements.connection.textContent = text;
			elements.connection.className = `connection ${kind}`;
		},
	};

	elements.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		if (lastView?.attachedId === undefined) return;
		const text = draft();
		if (text.length === 0) {
			// An empty draft leaves the primary as the stop control; `Enter` on it must not no-op.
			if (stops) renderer.onAbort();
			return;
		}
		elements.prompt.value = "";
		fitPrompt(elements.prompt);
		renderPrimary();
		renderer.onSubmit(text);
	});
	elements.prompt.addEventListener("input", () => {
		fitPrompt(elements.prompt);
		// The draft's emptiness decides whether the primary sends or stops.
		renderPrimary();
	});
	elements.prompt.addEventListener("keydown", (event) => {
		// Enter submits, Shift+Enter keeps the newline: the same contract the TUI composer uses.
		if (event.key !== "Enter" || event.shiftKey) return;
		event.preventDefault();
		elements.composer.requestSubmit();
	});
	return renderer;
}
