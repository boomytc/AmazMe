import type { Locale } from "./locale.ts";
import { PROJECT_EDIT_ACTION, PROJECT_REMOVE_ACTION } from "./projects.ts";
import { translate } from "./strings.ts";
import { rosterItems, type SessionDirectoryLike } from "./view.ts";

export interface SidebarMenuItem {
	readonly id: string;
	readonly label: string;
	readonly danger?: true;
}

export interface SidebarProject {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;
	readonly selected: boolean;
	readonly menu: readonly SidebarMenuItem[];
}

export interface SidebarProjectsClosed {
	readonly expanded: false;
	readonly reveal: true;
	readonly label: string;
}

export interface SidebarProjectsOpen {
	readonly expanded: true;
	readonly reveal: false;
	readonly label: string;
}

export type SidebarProjectFold = SidebarProjectsClosed | SidebarProjectsOpen;

export interface SidebarRecentSession {
	readonly kind: "recent";
	readonly id: string;
	readonly label: string;
	readonly cwd?: string;
	readonly attached: boolean;
}

export interface SidebarArchivedSession {
	readonly kind: "archived";
	readonly id: string;
	readonly label: string;
	readonly cwd?: string;
	readonly attached: true;
	readonly age: string;
	readonly ageIso: string;
	readonly menu?: never;
}

export type SidebarSession = SidebarRecentSession | SidebarArchivedSession;

export interface SidebarDocument {
	readonly projects: readonly SidebarProject[];
	readonly projectFold?: SidebarProjectFold;
	readonly recent: readonly SidebarRecentSession[];
	readonly archivedAttached?: SidebarArchivedSession;
}

export interface SidebarQuery {
	readonly locale: Locale;
	readonly directory: SessionDirectoryLike;
	readonly attachedId: string | undefined;
	readonly now: number;
	readonly filter: string;
	readonly selectedProjectId: string | undefined;
	readonly projectsRevealed: boolean;
}

/** Names past this count stay behind the fold until the reader opens it. */
const PROJECT_PREVIEW_LIMIT = 5;

function projectMenu(locale: Locale): readonly SidebarMenuItem[] {
	return [
		{ id: PROJECT_EDIT_ACTION, label: translate(locale, "project.edit") },
		{ id: PROJECT_REMOVE_ACTION, label: translate(locale, "project.remove"), danger: true },
	];
}

function projectMatches(
	project: { readonly name: string; readonly cwd: string; readonly workspaces?: readonly string[] },
	needle: string,
): boolean {
	if (needle.length === 0) return true;
	return [project.name, project.cwd, ...(project.workspaces ?? [])].some((field) => field.toLowerCase().includes(needle));
}

function visibleProjects(
	matched: readonly SidebarProject[],
	input: SidebarQuery,
	filtering: boolean,
): Pick<SidebarDocument, "projects" | "projectFold"> {
	if (filtering || matched.length <= PROJECT_PREVIEW_LIMIT) return { projects: matched };
	if (input.projectsRevealed) {
		return {
			projects: matched,
			projectFold: {
				expanded: true,
				reveal: false,
				label: translate(input.locale, "sidebar.hideProjects"),
			},
		};
	}
	const selectedIndex = matched.findIndex((project) => project.id === input.selectedProjectId);
	const pinned = selectedIndex >= PROJECT_PREVIEW_LIMIT ? matched[selectedIndex] : undefined;
	/* A selected project past the preview takes the fifth slot. Opening the fold returns to directory order. */
	return {
		projects: pinned === undefined ? matched.slice(0, PROJECT_PREVIEW_LIMIT) : [...matched.slice(0, PROJECT_PREVIEW_LIMIT - 1), pinned],
		projectFold: {
			expanded: false,
			reveal: true,
			label: translate(input.locale, "sidebar.showProjects"),
		},
	};
}

function listedCwd(cwd: string | undefined): { readonly cwd?: string } {
	return cwd === undefined ? {} : { cwd };
}

/** Project names in host order, then the non-archived sessions `rosterItems` already ordered. */
export function sidebarDocument(input: SidebarQuery): SidebarDocument {
	const needle = input.filter.trim().toLowerCase();
	const menu = projectMenu(input.locale);
	const matched = (input.directory.projects ?? [])
		.filter((project) => project.removed !== true && projectMatches(project, needle))
		.map((project) => ({
			id: project.id,
			name: project.name,
			cwd: project.cwd,
			selected: project.id === input.selectedProjectId,
			menu,
		}));
	const archived = rosterItems(input.locale, input.directory, input.attachedId, input.now, "", true).find((item) => item.id === input.attachedId);
	return {
		...visibleProjects(matched, input, needle.length > 0),
		recent: rosterItems(input.locale, input.directory, input.attachedId, input.now, input.filter).map((item) => ({
			kind: "recent" as const,
			id: item.id,
			label: item.label,
			...listedCwd(item.cwd),
			attached: item.attached,
		})),
		...(archived === undefined ? {} : {
			archivedAttached: {
				kind: "archived" as const,
				id: archived.id,
				label: archived.label,
				...listedCwd(archived.cwd),
				attached: true as const,
				age: archived.age,
				ageIso: archived.ageIso,
			},
		}),
	};
}
