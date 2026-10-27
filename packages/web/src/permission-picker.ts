import type { Locale } from "./locale.ts";
import type { Submit } from "./generated/contracts.ts";
import { translate, type MessageKey } from "./strings.ts";

export type ApprovalPolicy = NonNullable<Submit["approval_policy"]>;

const modes = [
	{ value: "all", icon: "hand", label: "permission.ask", description: "permission.askDescription" },
	{ value: "mutations", icon: "shield-check", label: "permission.assist", description: "permission.assistDescription" },
	{ value: "auto", icon: "shield-alert", label: "permission.full", description: "permission.fullDescription" },
] satisfies readonly { value: ApprovalPolicy; icon: string; label: MessageKey; description: MessageKey }[];

function icon(name: string): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", "icon");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(svg.namespaceURI, "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

export function createPermissionPicker(select: (policy: ApprovalPolicy) => void) {
	const root = document.createElement("div");
	root.className = "permission-control";
	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "permission-trigger";
	trigger.setAttribute("aria-haspopup", "dialog");
	trigger.setAttribute("aria-expanded", "false");
	const dialog = document.createElement("dialog");
	dialog.className = "permission-menu";
	const group = document.createElement("div");
	group.setAttribute("role", "menu");
	const hint = document.createElement("p");
	hint.className = "permission-hint";
	dialog.append(group, hint);
	root.append(trigger, dialog);
	const options = modes.map(mode => {
		const control = document.createElement("button");
		control.type = "button";
		control.className = "permission-option";
		control.dataset.policy = mode.value;
		control.setAttribute("role", "menuitemradio");
		const text = document.createElement("span");
		text.className = "permission-copy";
		const label = document.createElement("span");
		label.className = "permission-label";
		const description = document.createElement("span");
		description.className = "permission-description";
		const check = icon("check");
		check.classList.add("permission-check");
		text.append(label, description);
		control.append(icon(mode.icon), text, check);
		control.addEventListener("click", () => { dialog.close(); select(mode.value); });
		group.append(control);
		return { mode, control, label, description, check };
	});

	trigger.addEventListener("click", () => {
		if (dialog.open) { dialog.close(); return; }
		dialog.showModal();
		const anchor = trigger.getBoundingClientRect();
		const ceiling = trigger.closest("form")?.getBoundingClientRect().top ?? anchor.top;
		dialog.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - dialog.offsetWidth - 8))}px`;
		dialog.style.bottom = `${window.innerHeight - ceiling + 8}px`;
		dialog.style.maxHeight = `${Math.max(120, ceiling - 16)}px`;
		trigger.setAttribute("aria-expanded", "true");
		options.find(option => option.control.getAttribute("aria-checked") === "true")?.control.focus();
	});
	dialog.addEventListener("close", () => {
		trigger.setAttribute("aria-expanded", "false");
		if (!trigger.disabled) trigger.focus({ preventScroll: true });
	});
	dialog.addEventListener("pointerdown", event => {
		if (event.target !== dialog) return;
		const bounds = dialog.getBoundingClientRect();
		if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
	});
	dialog.addEventListener("keydown", event => {
		if (event.key === "Escape") { event.preventDefault(); dialog.close(); return; }
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		event.preventDefault();
		const index = options.findIndex(option => option.control === document.activeElement);
		const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
			: (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
		options[next]?.control.focus();
	});
	return { element: root, close: () => dialog.close(), update(locale: Locale, policy: ApprovalPolicy, disabled: boolean) {
		const copy = (key: MessageKey) => translate(locale, key);
		const selected = modes.find(mode => mode.value === policy);
		if (!selected) return;
		trigger.replaceChildren(icon(selected.icon), document.createTextNode(copy(selected.label)), icon("chevron-down"));
		trigger.dataset.policy = policy;
		trigger.disabled = disabled;
		trigger.title = copy("permission.nextRequest");
		trigger.setAttribute("aria-label", `${copy("permission.heading")}: ${copy(selected.label)}`);
		dialog.setAttribute("aria-label", copy("permission.heading"));
		group.setAttribute("aria-label", copy("permission.heading"));
		hint.textContent = copy("permission.nextRequest");
		for (const option of options) {
			option.label.textContent = copy(option.mode.label);
			option.description.textContent = copy(option.mode.description);
			option.control.setAttribute("aria-checked", String(option.mode.value === policy));
			option.check.style.visibility = option.mode.value === policy ? "visible" : "hidden";
		}
		if (disabled && dialog.open) dialog.close();
	} };
}
