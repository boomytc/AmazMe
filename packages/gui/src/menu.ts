/**
 * Edit actions for a right-click inside the page.
 *
 * The template is data. Electron turns each `role` into the real undo/cut/copy action.
 * Labels come from the shell catalog so they follow the same language as the dialogs.
 */
import type { Locale } from "./locale.ts";
import { translate, type MessageKey } from "./strings.ts";

/** Built-in edit roles the template is allowed to ask Electron for. */
export type EditRole = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

/** The edit flags Electron reports. Enabled state is copied from these, not invented. */
export interface EditFlags {
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	readonly canCut: boolean;
	readonly canCopy: boolean;
	readonly canPaste: boolean;
	readonly canSelectAll: boolean;
}

/**
 * The slice of `context-menu` params this menu reads. `selectionText` is empty when nothing
 * is selected, including a selection that is only the absence of a range.
 */
export interface EditMenuParams {
	readonly isEditable: boolean;
	readonly selectionText: string;
	readonly editFlags: EditFlags;
}

export interface EditMenuItem {
	readonly role: EditRole;
	readonly label: string;
	readonly enabled: boolean;
}

const EDIT_ACTIONS = [
	["undo", "menu.undo", "canUndo"],
	["redo", "menu.redo", "canRedo"],
	["cut", "menu.cut", "canCut"],
	["copy", "menu.copy", "canCopy"],
	["paste", "menu.paste", "canPaste"],
	["selectAll", "menu.selectAll", "canSelectAll"],
] as const satisfies readonly (readonly [EditRole, MessageKey, keyof EditFlags])[];

function item(locale: Locale, role: EditRole, key: MessageKey, enabled: boolean): EditMenuItem {
	return { role, label: translate(locale, key), enabled };
}

/**
 * Context-menu template. An editable field gets the edit actions, each enabled from
 * `editFlags`. Anywhere else, a non-empty selection gets Copy alone. Otherwise there is
 * nothing to show and the caller skips the popup.
 */
export function editMenuTemplate(params: EditMenuParams, locale: Locale): readonly EditMenuItem[] {
	if (params.isEditable) {
		return EDIT_ACTIONS.map(([role, key, flag]) => item(locale, role, key, params.editFlags[flag]));
	}
	if (params.selectionText.length === 0) return [];
	return [item(locale, "copy", "menu.copy", params.editFlags.canCopy)];
}
