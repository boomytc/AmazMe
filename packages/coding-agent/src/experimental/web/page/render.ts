/// <reference lib="dom" />
/**
 * Thin DOM renderer: it turns the pure view model into elements and owns no state of its own.
 * Every update rebuilds the panels, then restores the transcript's scroll position so streaming
 * does not yank the reader around.
 */
import type { TranscriptBlock, WebView } from "../view.ts";

export interface PageElements {
	readonly connection: HTMLElement;
	readonly mode: HTMLElement;
	readonly roster: HTMLElement;
	readonly transcript: HTMLElement;
	readonly status: HTMLElement;
	readonly queue: HTMLElement;
}

export interface PageRenderer {
	render(view: WebView): void;
	setConnection(text: string, kind: "state" | "error"): void;
	/** Set by the page entry once it can attach a session. */
	onSelect: (sessionId: string) => void;
}

export function collectPageElements(): PageElements {
	const pick = (id: string): HTMLElement => {
		const element = document.getElementById(id);
		if (element === null) throw new Error(`Page document is missing #${id}`);
		return element;
	};
	return {
		connection: pick("connection"),
		mode: pick("mode"),
		roster: pick("roster"),
		transcript: pick("transcript"),
		status: pick("status"),
		queue: pick("queue"),
	};
}

const BLOCK_CLASS: Readonly<Record<TranscriptBlock["kind"], string>> = {
	user: "block user",
	assistant: "block assistant",
	thinking: "block thinking",
	tool: "block tool",
	notice: "block notice",
};

function atBottom(element: HTMLElement): boolean {
	return element.scrollHeight - element.scrollTop - element.clientHeight < 24;
}

function blockElement(block: TranscriptBlock): HTMLElement {
	const wrap = document.createElement("article");
	wrap.className = BLOCK_CLASS[block.kind];
	if (block.tone === "error") wrap.classList.add("error");
	if (block.tone === "muted") wrap.classList.add("muted");
	if (block.running) wrap.classList.add("running");
	const title = document.createElement(block.kind === "assistant" ? "h3" : "h4");
	title.textContent = block.title;
	wrap.append(title);
	const body = document.createElement("pre");
	body.textContent = block.text.length > 0 ? block.text : block.running ? "…" : "";
	wrap.append(body);
	return wrap;
}

export function createRenderer(elements: PageElements, onSelect: (sessionId: string) => void = () => {}): PageRenderer {
	const renderer: PageRenderer = {
		onSelect,
		render(view: WebView): void {
			const stick = atBottom(elements.transcript);
			elements.roster.replaceChildren();
			for (const item of view.roster) {
				const row = document.createElement("button");
				row.type = "button";
				row.className = item.attached ? "roster-row attached" : "roster-row";
				row.dataset.sessionId = item.id;
				const label = document.createElement("span");
				label.className = "session";
				label.textContent = item.label;
				const age = document.createElement("time");
				age.dateTime = item.ageIso;
				age.textContent = item.age;
				row.append(label, age);
				row.addEventListener("click", () => renderer.onSelect(item.id));
				elements.roster.append(row);
			}
			if (view.roster.length === 0) {
				const empty = document.createElement("p");
				empty.className = "state";
				empty.id = "roster-empty";
				empty.textContent = view.empty ?? "No sessions on this host yet.";
				elements.roster.append(empty);
			}

			elements.transcript.replaceChildren();
			for (const block of view.blocks) elements.transcript.append(blockElement(block));
			if (view.blocks.length === 0) {
				const empty = document.createElement("p");
				empty.className = "state";
				empty.id = "transcript-empty";
				empty.textContent = view.attachedId === undefined ? "No session attached." : "No entries in this session yet.";
				elements.transcript.append(empty);
			}
			if (stick) elements.transcript.scrollTop = elements.transcript.scrollHeight;

			elements.status.textContent = view.status;
			elements.status.classList.toggle("busy", view.status.length > 0);
			elements.status.classList.remove("error");
			elements.queue.replaceChildren();
			for (const item of view.queue) {
				const line = document.createElement("p");
				line.className = "state muted";
				line.textContent = item;
				elements.queue.append(line);
			}
		},
		setConnection(text: string, kind: "state" | "error"): void {
			elements.connection.textContent = text;
			elements.connection.className = kind;
		},
	};
	return renderer;
}
