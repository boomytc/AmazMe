import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { resolvePath } from "../utils/paths.ts";

export interface ProjectMetadata {
	readonly id: string;
	readonly name: string;
	readonly cwd: string;
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
		return value as ProjectMetadata[];
	}
	async initialize(directories: readonly string[]): Promise<ProjectMetadata[]> {
		const paths = await Promise.all(directories.map(async cwd => {
			try { return await realpath(cwd); }
			catch { return resolve(cwd); }
		}));
		return this.#update(projects => {
			for (const cwd of new Set(paths)) {
				if (!projects.some(project => project.cwd === cwd)) projects.push({ id: randomUUID(), name: basename(cwd) || cwd, cwd, createdAt: Date.now() });
			}
			return projects;
		});
	}
	async create(cwd: string, name?: string): Promise<ProjectMetadata> {
		if (!cwd.trim()) throw new Error("Working directory is required");
		const path = await realpath(resolvePath(cwd));
		if (!(await stat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
		return this.#update(projects => {
			const index = projects.findIndex(project => project.cwd === path);
			const previous = projects[index];
			const project: ProjectMetadata = {
				id: previous?.id ?? randomUUID(), cwd: path, createdAt: previous?.createdAt ?? Date.now(),
				name: name?.replace(/[\r\n]+/g, " ").trim() || previous?.name || basename(path) || path,
			};
			if (index < 0) projects.push(project); else projects[index] = project;
			return project;
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
		&& typeof row.createdAt === "number" && Number.isFinite(row.createdAt) && (row.removed === undefined || row.removed === true);
}
