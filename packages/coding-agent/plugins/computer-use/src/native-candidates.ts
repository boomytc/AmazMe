import { createHash } from "node:crypto";
import type { ComputerUseSettings, RiskCategory } from "./config.ts";
import { isRecord } from "./config.ts";

export type Element = Readonly<Record<string, unknown>>;
export type Rect = { x: number; y: number; width: number; height: number };
export type NativeObservation = {
	elements: readonly Element[];
	windowBounds?: Rect;
	degradedReason?: string;
	treeMarkdown: string;
};
export type Role =
	| "button"
	| "toggle"
	| "checkbox"
	| "radio"
	| "popup"
	| "menu_item"
	| "link"
	| "text_input";
export type Candidate = {
	id: string;
	role: Role;
	label: string;
	elementToken: string;
	value?: string;
};
export const FALLBACK_CANDIDATES = {
	reobserve: "Take a fresh observation; do not act",
	abstain: "No safe matching action; do not act",
};

export const RISK_PHRASES: Readonly<Record<RiskCategory, readonly string[]>> = {
	destructive: [
		"delete",
		"remove",
		"erase",
		"trash",
		"discard",
		"clear all",
		"format",
		"reset",
		"删除",
		"移除",
		"清空",
		"重置",
		"丢弃",
	],
	send: [
		"send",
		"submit",
		"post",
		"publish",
		"share",
		"reply",
		"发送",
		"提交",
		"发布",
		"分享",
		"回复",
	],
	purchase: [
		"buy",
		"purchase",
		"pay",
		"checkout",
		"order",
		"subscribe",
		"购买",
		"付款",
		"支付",
		"下单",
		"订阅",
	],
	close_unsaved: [
		"close",
		"quit",
		"exit",
		"don't save",
		"discard changes",
		"关闭",
		"退出",
		"不保存",
	],
};

export function riskCategories(label: string): RiskCategory[] {
	const text = label.toLowerCase().replaceAll("’", "'");
	return (Object.keys(RISK_PHRASES) as RiskCategory[]).filter((category) =>
		RISK_PHRASES[category].some((phrase) =>
			/\P{ASCII}/u.test(phrase)
				? text.includes(phrase)
				: new RegExp(
						`(?<![a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`,
						"u",
					).test(text),
		),
	);
}

export function blockedRisks(
	text: string,
	policy: ComputerUseSettings,
): RiskCategory[] {
	return riskCategories(text).filter(
		(category) => !policy.allowRiskCategories.includes(category),
	);
}

export function normalizedRole(value: unknown): string {
	const role =
		typeof value === "string"
			? value
					.toLowerCase()
					.replace(/[^a-z0-9]/g, "")
					.replace(/^ax/, "")
			: "";
	return role === "pushbutton" ? "button" : role;
}

const roles: Record<string, Role> = {
	button: "button",
	splitbutton: "button",
	switch: "toggle",
	togglebutton: "toggle",
	checkbox: "checkbox",
	radiobutton: "radio",
	popupbutton: "popup",
	combobox: "popup",
	menubutton: "popup",
	menuitem: "menu_item",
	checkmenuitem: "menu_item",
	radiomenuitem: "menu_item",
	link: "link",
	hyperlink: "link",
	textfield: "text_input",
	textarea: "text_input",
	searchfield: "text_input",
	securetextfield: "text_input",
	edit: "text_input",
	entry: "text_input",
	text: "text_input",
	passwordtext: "text_input",
};
const rootRoles = new Set(["window", "frame", "application"]);
const chromeRoles = new Set(["titlebar", "menubar", "menubaritem"]);

export function rect(value: unknown): Rect | undefined {
	if (!isRecord(value)) return;
	const x = value.x,
		y = value.y,
		width = value.width ?? value.w,
		height = value.height ?? value.h;
	if (
		![x, y, width, height].every(
			(n) => typeof n === "number" && Number.isFinite(n),
		)
	)
		return;
	return { x, y, width, height } as Rect;
}

function intersects(a: Rect, b: Rect): boolean {
	return (
		a.width > 0 &&
		a.height > 0 &&
		Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
		Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
	);
}

/** Cross-platform native role normalization; ambiguous identical controls are omitted, never indexed by position. */
export function extractCandidates(
	observation: NativeObservation,
	policy: ComputerUseSettings,
): Candidate[] {
	const byIndex = new Map(
		observation.elements.map((element) => [element.element_index, element]),
	);
	const pending: Candidate[] = [];
	for (const item of observation.elements) {
		const role = roles[normalizedRole(item.role)];
		const label =
			typeof item.label === "string"
				? item.label.replace(/\s+/g, " ").trim()
				: "";
		const frame = rect(item.frame);
		if (
			!role ||
			!label ||
			item.unlabelled === true ||
			item.enabled === false ||
			item.visible === false ||
			item.offscreen === true ||
			!frame ||
			!observation.windowBounds ||
			!intersects(frame, observation.windowBounds) ||
			typeof item.element_token !== "string" ||
			!item.element_token ||
			blockedRisks(label, policy).length
		)
			continue;
		const ancestors: Element[] = [];
		const seen = new Set<unknown>([item.element_index]);
		let parent = byIndex.get(item.parent_index);
		while (parent && !seen.has(parent.element_index)) {
			seen.add(parent.element_index);
			ancestors.push(parent);
			parent = byIndex.get(parent.parent_index);
		}
		if (
			parent ||
			[...ancestors, item].some((el) =>
				chromeRoles.has(normalizedRole(el.role)),
			)
		)
			continue;
		const subrole = normalizedRole(item.subrole);
		if (
			[
				"closebutton",
				"minimizebutton",
				"zoombutton",
				"fullscreenbutton",
			].includes(subrole)
		)
			continue;
		if (
			role === "button" &&
			rootRoles.has(normalizedRole(ancestors[0]?.role)) &&
			/^(close|minimi[sz]e|maximi[sz]e|zoom|关闭|最小化|最大化)$/iu.test(label)
		)
			continue;
		const path = ancestors
			.reverse()
			.map((el) => [normalizedRole(el.role), el.label ?? ""]);
		const id = `ax_${createHash("sha256")
			.update(JSON.stringify([role, label, path]))
			.digest("hex")
			.slice(0, 20)}`;
		pending.push({
			id,
			role,
			label,
			elementToken: item.element_token,
			...(typeof item.value === "string"
				? { value: item.value.slice(0, 1000) }
				: {}),
		});
	}
	const counts = new Map<string, number>();
	for (const candidate of pending)
		counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
	return pending
		.filter((candidate) => counts.get(candidate.id) === 1)
		.slice(0, 24);
}

export function visualFallbackReason(
	observation: NativeObservation,
	candidates: readonly Candidate[],
): string | undefined {
	if (observation.degradedReason?.startsWith("ax_tree_empty"))
		return "ax_tree_empty";
	if (
		!observation.elements.some(
			(item) => !rootRoles.has(normalizedRole(item.role)),
		)
	)
		return "ax_tree_empty";
	if (!candidates.length) return "target_not_in_ax_candidates";
	return undefined;
}
