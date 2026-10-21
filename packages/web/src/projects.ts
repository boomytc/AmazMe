import type { Locale } from "./locale.ts";
import type { PanelModal } from "./panels.ts";
import { translate } from "./strings.ts";
import type { RosterItem, SessionDirectoryLike } from "./view.ts";

export const PROJECT_ADD_ACTION = "project:add";
export const PROJECT_ADD_MODAL = "project:add-submit";
/** Opens or closes one project's session list. Projects toggle independently of the current project. */
export const PROJECT_SELECT_ACTION = "project:select";
export const PROJECT_NEW_SESSION_ACTION = "project:new-session";
export const COMPOSER_PROJECT_ACTION = "composer:project";
export const PROJECT_EDIT_ACTION = "project:edit";
export const PROJECT_EDIT_MODAL = "project:edit-submit";
export const PROJECT_RENAME_ACTION = "project:rename";
export const PROJECT_RENAME_MODAL = "project:rename-submit";
export const PROJECT_REMOVE_ACTION = "project:remove";
export const PROJECT_REMOVE_MODAL = "project:remove-confirm";
export const SESSION_ARCHIVE_OPEN_ACTION = "session:open-archived";
export const SESSION_ARCHIVE_ACTION = "session:archive";
export const SESSION_ARCHIVE_MODAL = "session:archive-confirm";
export const SESSION_RESTORE_ACTION = "session:restore";

export interface ProjectGroup {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;
	readonly workspaces?: readonly string[];
	readonly selected: boolean;
	/** Whether this project's sessions are listed. Independent of `selected`. */
	readonly expanded: boolean;
	readonly items: readonly RosterItem[];
	readonly removed?: true;
}

/** Add `id` to the open set, or remove it when it is already open. Other ids stay as they are. */
export function toggleExpandedProjects(expanded: readonly string[], id: string): readonly string[] {
	return expanded.includes(id) ? expanded.filter(projectId => projectId !== id) : [...expanded, id];
}

export function projectGroups(directory: SessionDirectoryLike | undefined, items: readonly RosterItem[], selectedId: string | null | undefined, filter: string, expandedIds?: readonly string[]): ProjectGroup[] | undefined {
	if (directory?.projects === undefined) return undefined;
	const needle = filter.trim().toLowerCase();
	const explicit = expandedIds !== undefined;
	const open = new Set(expandedIds ?? []);
	return directory.projects.filter(project => !project.removed).map(project => {
		const groupItems = items.filter(item => item.projectId === project.id);
		return {
			...project,
			selected: project.id === selectedId,
			expanded: explicit ? open.has(project.id) : project.id === selectedId,
			items: groupItems,
		};
	}).filter(group => !needle || group.items.length > 0 || `${group.name} ${(group.workspaces ?? [group.cwd]).join(" ")}`.toLowerCase().includes(needle));
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

export function archiveSessionModal(locale: Locale, id: string): PanelModal {
	return { id: SESSION_ARCHIVE_MODAL, title: translate(locale, "project.archive"), data: id, description: translate(locale, "project.archiveHint"), fields: [], submit: translate(locale, "project.archive"), danger: true };
}
