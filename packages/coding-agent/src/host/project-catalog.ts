import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { resolvePath } from "../utils/paths.ts";
import { isProjectSelection } from "./services/projects.ts";
import type { ProjectFolders, ProjectSelection } from "./services/projects.ts";

export interface ProjectMetadata {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;
	readonly workspaces?: string[];
	readonly revision?: number;
	readonly createdAt: number;
	readonly removed?: true;
}

/** Independent of session storage: an empty project survives, and removal keeps its sessions. */
export class ProjectCatalog {
	readonly #directory: string;
	readonly #file: string;
	constructor(sessionDirectory: string) {
		this.#directory = sessionDirectory;
		this.#file = join(sessionDirectory, ".projects.json");
	}
	async list(): Promise<ProjectMetadata[]> {
		let value: unknown;
		try { value = JSON.parse(await readFile(this.#file, "utf8")); }
		catch (error: unknown) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		if (!Array.isArray(value) || value.some(row => !isProject(row))) throw new Error("Invalid project catalog");
		return (value as ProjectMetadata[]).map(project => ({ ...project, workspaces: project.workspaces ?? [project.cwd] }));
	}
	async selection(): Promise<ProjectSelection | undefined> {
		try {
			const value: unknown = JSON.parse(await readFile(join(this.#directory, ".selection.json"), "utf8"));
			return isProjectSelection(value) ? value : undefined;
		} catch (error: unknown) {
			if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
			throw error;
		}
	}
	/** The host serializes writes; replacement is atomic even if it stops during a selection. */
	async remember(selection: ProjectSelection): Promise<void> {
		if (!isProjectSelection(selection)) throw new Error("Invalid project selection");
		const file = join(this.#directory, ".selection.json");
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(selection)}\n`);
			await rename(temporary, file);
		} finally { await rm(temporary, { force: true }); }
	}
	async initialize(directories: readonly string[]): Promise<ProjectMetadata[]> {
		const paths = await Promise.all(directories.map(async cwd => {
			try { return await realpath(cwd); }
			catch { return resolve(cwd); }
		}));
		return this.#update(projects => {
			for (const cwd of new Set(paths)) {
				if (!projects.some(project => (project.workspaces ?? [project.cwd]).includes(cwd))) projects.push({ id: randomUUID(), name: basename(cwd) || cwd, cwd, workspaces: [cwd], createdAt: Date.now() });
			}
			return projects;
		});
	}
	async create(cwd: string, name?: string, directories: readonly string[] = [cwd]): Promise<ProjectMetadata> {
		const workspaces = await normalizeProjectDirectories(directories);
		const path = workspaces[0]!;
		return this.#update(projects => {
			const index = projects.findIndex(project => {
				const roots = project.workspaces ?? [project.cwd];
				return roots.length === workspaces.length && roots.every(root => workspaces.includes(root));
			});
			const previous = projects[index];
			const project: ProjectMetadata = {
				id: previous?.id ?? randomUUID(), cwd: path, workspaces, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? Date.now(),
				name: name?.replace(/[\r\n]+/g, " ").trim() || previous?.name || basename(path) || path,
			};
			if (index < 0) projects.push(project); else projects[index] = project;
			return project;
		});
	}
	async update(id: string, name: string, directories: readonly string[]): Promise<ProjectMetadata> {
		if (!name.trim()) throw new Error("Project name is required");
		const workspaces = await normalizeProjectDirectories(directories);
		return this.#update(projects => {
			const index = projects.findIndex(project => project.id === id && !project.removed);
			if (index < 0) throw new Error(`Unknown project: ${id}`);
			const previous = projects[index]!;
			return projects[index] = { ...previous, name: name.replace(/[\r\n]+/g, " ").trim(), cwd: workspaces[0]!, workspaces, revision: (previous.revision ?? 0) + 1 };
		});
	}
	async rename(id: string, name: string): Promise<ProjectMetadata> {
		if (!name.trim()) throw new Error("Project name is required");
		return this.#update(projects => {
			const index = projects.findIndex(project => project.id === id && !project.removed);
			if (index < 0) throw new Error(`Unknown project: ${id}`);
			return projects[index] = { ...projects[index]!, name: name.replace(/[\r\n]+/g, " ").trim() };
		});
	}
	async remove(id: string): Promise<void> {
		await this.#update(projects => {
			const index = projects.findIndex(project => project.id === id);
			if (index < 0) throw new Error(`Unknown project: ${id}`);
			projects[index] = { ...projects[index]!, removed: true };
		});
	}
	async restore(id: string): Promise<ProjectMetadata> {
		return this.#update(projects => {
			const index = projects.findIndex(project => project.id === id);
			if (index < 0) throw new Error(`Unknown project: ${id}`);
			const { removed: _removed, ...project } = projects[index]!;
			return projects[index] = project;
		});
	}
	async #update<T>(change: (projects: ProjectMetadata[]) => T): Promise<T> {
		await mkdir(this.#directory, { recursive: true });
		const release = await lockfile.lock(this.#file, { realpath: false, retries: { retries: 20, minTimeout: 20, maxTimeout: 100 } });
		const temporary = `${this.#file}.${randomUUID()}.tmp`;
		try {
			const projects = await this.list();
			const result = change(projects);
			await writeFile(temporary, `${JSON.stringify(projects, null, "\t")}\n`);
			await rename(temporary, this.#file);
			return result;
		} finally {
			try { await rm(temporary, { force: true }); } finally { await release(); }
		}
	}
}

function isProject(value: unknown): value is ProjectMetadata {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row.id === "string" && typeof row.name === "string" && typeof row.cwd === "string"
		&& (row.workspaces === undefined || (Array.isArray(row.workspaces) && row.workspaces.length > 0 && row.workspaces.every(path => typeof path === "string") && row.workspaces[0] === row.cwd))
		&& (row.revision === undefined || (typeof row.revision === "number" && Number.isSafeInteger(row.revision) && row.revision > 0))
		&& typeof row.createdAt === "number" && Number.isFinite(row.createdAt) && (row.removed === undefined || row.removed === true);
}

export async function normalizeProjectDirectories(directories: readonly string[]): Promise<string[]> {
	if (directories.length === 0 || directories.some(path => !path.trim())) throw new Error("Working directory is required");
	const paths = await Promise.all(directories.map(async directory => {
		const path = await realpath(resolvePath(directory));
		if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
		return path;
	}));
	return [...new Set(paths)];
}

export async function listProjectFolders(directory?: string): Promise<ProjectFolders> {
	const path = await realpath(resolvePath(directory?.trim() || process.cwd()));
	const entries = await readdir(path, { withFileTypes: true });
	const folders = await Promise.all(entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(async entry => {
		const child = join(path, entry.name);
		try { return (await stat(child)).isDirectory() ? { name: entry.name, path: child } : undefined; }
		catch { return undefined; }
	}));
	return { path, parent: dirname(path) === path ? null : dirname(path),
		entries: folders.filter(entry => entry !== undefined).sort((a, b) => a.name.localeCompare(b.name)) };
}
