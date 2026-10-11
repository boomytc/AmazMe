import type { Locale } from "./locale.ts";
import type { PanelModal } from "./panels.ts";
import { translate } from "./strings.ts";
import type { RosterItem, SessionDirectoryLike } from "./view.ts";

export const PROJECT_ADD_ACTION = "project:add";
export const PROJECT_ADD_MODAL = "project:add-submit";
export const PROJECT_SELECT_ACTION = "project:select";
export const PROJECT_NEW_SESSION_ACTION = "project:new-session";
export const PROJECT_EDIT_ACTION = "project:edit";
export const PROJECT_EDIT_MODAL = "project:edit-submit";
export const PROJECT_RENAME_ACTION = "project:rename";
export const PROJECT_RENAME_MODAL = "project:rename-submit";
export const PROJECT_REMOVE_ACTION = "project:remove";
export const PROJECT_REMOVE_MODAL = "project:remove-confirm";
export const ARCHIVE_TOGGLE_ACTION = "session:show-archived";
export const ARCHIVE_MANAGE_ACTION = "session:manage-archived";
export const SESSION_ARCHIVE_ACTION = "session:archive";
export const SESSION_RESTORE_ACTION = "session:restore";

export interface ProjectGroup {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;
	readonly workspaces?: readonly string[];
	readonly selected: boolean;
	readonly items: readonly RosterItem[];
	readonly removed?: true;
}

export function projectGroups(directory: SessionDirectoryLike | undefined, items: readonly RosterItem[], selectedId: string | undefined, archived: boolean, filter: string): ProjectGroup[] | undefined {
	if (directory?.projects === undefined) return undefined;
	const needle = filter.trim().toLowerCase();
	return directory.projects.filter(project => archived || !project.removed).map(project => ({
		...project,
		selected: project.id === selectedId,
		items: items.filter(item => item.projectId === project.id),
	})).filter(group => archived ? group.items.length > 0 : !needle || group.items.length > 0 || `${group.name} ${(group.workspaces ?? [group.cwd]).join(" ")}`.toLowerCase().includes(needle));
}

export function addProjectModal(locale: Locale): PanelModal {
	return { id: PROJECT_ADD_MODAL, title: translate(locale, "project.create"),
		fields: [{ id: "name", label: translate(locale, "project.name"), placeholder: translate(locale, "project.name"), kind: "text", value: "" },
			{ id: "workspaces", label: translate(locale, "project.folders"), kind: "directories", value: "[]" }],
		submit: translate(locale, "project.create") };
}

export function editProjectModal(locale: Locale, project: { id: string; name: string; cwd: string; workspaces?: readonly string[] }): PanelModal {
	return { ...addProjectModal(locale), id: PROJECT_EDIT_MODAL, title: translate(locale, "project.edit"), data: project.id,
		fields: [{ id: "name", label: translate(locale, "project.name"), placeholder: translate(locale, "project.name"), kind: "text", value: project.name },
			{ id: "workspaces", label: translate(locale, "project.folders"), kind: "directories", value: JSON.stringify(project.workspaces ?? [project.cwd]) }],
		submit: translate(locale, "modal.save") };
}

export function renameProjectModal(locale: Locale, id: string, name: string): PanelModal {
	return { id: PROJECT_RENAME_MODAL, title: translate(locale, "project.rename"), data: id,
		fields: [{ id: "name", label: translate(locale, "project.name"), kind: "text", value: name }], submit: translate(locale, "modal.save") };
}

export function removeProjectModal(locale: Locale, id: string, name: string): PanelModal {
	return { id: PROJECT_REMOVE_MODAL, title: translate(locale, "project.removeTitle", { name }), data: id,
		description: translate(locale, "project.removeHint"), fields: [], submit: translate(locale, "project.remove"), danger: true };
}
