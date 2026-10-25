/// <reference lib="dom" />
import { isRecord } from "./python-api.ts";

export interface PtyPresentation {
	readonly id: string;
	readonly cols: number;
	readonly rows: number;
	readonly output: string;
	readonly outputSeq: number;
	readonly inputEnabled: boolean;
}
interface Xterm {
	readonly cols: number;
	readonly rows: number;
	readonly element?: HTMLElement;
	readonly options: { disableStdin: boolean };
	open(element: HTMLElement): void;
	write(text: string, complete: () => void): void;
	reset(): void;
	resize(cols: number, rows: number): void;
	focus(): void;
	dispose(): void;
	onData(listener: (data: string) => void): void;
}
function isXterm(value: unknown): value is Xterm {
	return isRecord(value) && typeof value.cols === "number" && typeof value.rows === "number" && isRecord(value.options) &&
		["open", "write", "reset", "resize", "focus", "dispose", "onData"].every(name => typeof value[name] === "function");
}

/** xterm owns keyboard, paste, IME and control keys. The page owns transport and the input ledger. */
export function createPtySurface(report: { data(id: string, data: string): void; resize(id: string, cols: number, rows: number): void; error(error: unknown): void }) {
	const element = document.createElement("div");
	element.className = "pty-surface";
	let current: PtyPresentation | undefined, terminal: Xterm | undefined;
	let renderedSeq = 0, initialized = false, requestedSize = "", generation = 0;
	let updates = Promise.resolve();
	const fit = () => {
		if (!terminal || !current || !element.isConnected || element.clientWidth === 0) return;
		const screen = element.querySelector<HTMLElement>(".xterm-screen");
		if (!screen) return;
		const bounds = screen.getBoundingClientRect();
		const cellWidth = bounds.width / terminal.cols, cellHeight = bounds.height / terminal.rows;
		if (cellWidth <= 0 || cellHeight <= 0) return;
		const style = getComputedStyle(element);
		const cols = Math.max(2, Math.floor((element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / cellWidth));
		const rows = Math.max(2, Math.floor((element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / cellHeight));
		const key = `${cols}:${rows}`;
		if (requestedSize === key || (cols === current.cols && rows === current.rows)) return;
		requestedSize = key; report.resize(current.id, cols, rows);
	};
	const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
	observer?.observe(element);
	return {
		element,
		update(view: PtyPresentation): void {
			if (current?.id !== view.id) {
				generation++; terminal?.dispose(); terminal = undefined; element.replaceChildren(); renderedSeq = 0; initialized = false; requestedSize = "";
				updates = Promise.resolve();
			}
			current = view;
			const token = generation;
			const render = async () => {
				if (token !== generation || current?.id !== view.id) return;
				if (!terminal) {
					const module: unknown = await import(new URL("/client-assets/xterm-terminal.js", location.origin).href);
					if (token !== generation || current?.id !== view.id) return;
					if (!isRecord(module) || typeof module.Terminal !== "function") throw new Error("终端组件加载失败");
					const instance: unknown = Reflect.construct(module.Terminal, [{ cols: view.cols, rows: view.rows, scrollback: 1000, convertEol: false, disableStdin: !view.inputEnabled, fontFamily: "ui-monospace, monospace", fontSize: 13 }]);
					if (!isXterm(instance)) throw new Error("终端组件接口不匹配");
					terminal = instance;
					terminal.open(element);
					terminal.onData(data => { if (current?.inputEnabled && token === generation) report.data(view.id, data); });
				}
				terminal.options.disableStdin = !view.inputEnabled;
				if (terminal.cols !== view.cols || terminal.rows !== view.rows) terminal.resize(view.cols, view.rows);
				const delta = view.outputSeq - renderedSeq;
				let chunk = "";
				if (!initialized || delta < 0 || delta > view.output.length) { terminal.reset(); chunk = view.output; }
				else if (delta > 0) chunk = view.output.slice(view.output.length - delta);
				if (chunk) await new Promise<void>(resolve => terminal?.write(chunk, resolve));
				if (token !== generation) return;
				renderedSeq = view.outputSeq; initialized = true; fit();
			};
			updates = updates.then(render, render).catch(error => { if (token === generation) report.error(error); });
		},
		focus(): void { terminal?.focus(); },
		dispose(): void { generation++; observer?.disconnect(); terminal?.dispose(); terminal = undefined; },
	};
}
