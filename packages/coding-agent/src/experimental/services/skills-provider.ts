import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Context, type MutableReplicatedState } from "@amazme/chord";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { loadSkills, type Skill, type SkillFrontmatter } from "../../core/skills.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { SkillsState, SkillSummary } from "./skills.ts";

/** Same rules the Agent Skills spec applies to a skill name. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;

export interface SkillsServiceOptions {
	readonly agentDir: string;
	readonly cwd: string;
	/** The configured skill paths, read per load so a settings change is picked up. */
	readonly skillPaths: () => readonly string[];
}

function requireName(name: string): string {
	if (name.length === 0 || name.length > MAX_SKILL_NAME || !SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Skill name "${name}" must be lowercase letters, digits, and single hyphens, at most ${MAX_SKILL_NAME} characters`,
		);
	}
	return name;
}

function requireDescription(frontmatter: SkillFrontmatter, filePath: string): void {
	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		throw new Error(`${filePath} needs a description in its frontmatter`);
	}
}

function isInside(directory: string, path: string): boolean {
	const root = resolve(directory);
	const target = resolve(path);
	return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function summarize(skill: Skill, userDirectory: string): SkillSummary {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		scope: skill.sourceInfo.scope,
		disableModelInvocation: skill.disableModelInvocation,
		editable: isInside(userDirectory, skill.filePath),
	};
}

/**
 * The skills catalogue over the agent directory's `skills/` folder. Loading goes through the coding
 * agent's own loader, so the list a client sees is exactly the set the prompt receives.
 */
export function createSkillsService(
	options: SkillsServiceOptions,
	createState: (initial: SkillsState) => MutableReplicatedState<SkillsState>,
) {
	const userDirectory = join(options.agentDir, "skills");
	const service = {
		state: createState({ revision: 0, directory: userDirectory, skills: [], diagnostics: [] }),
	};
	const load = () =>
		loadSkills({ cwd: options.cwd, agentDir: options.agentDir, skillPaths: [...options.skillPaths()], includeDefaults: true });
	const found = (name: string): Skill => {
		const skill = load().skills.find((candidate) => candidate.name === name);
		if (skill === undefined) throw new Error(`Unknown skill: ${name}`);
		return skill;
	};
	const refresh = (context: Context): void => {
		const result = load();
		service.state.change(context, (draft) => {
			draft.revision += 1;
			draft.directory = userDirectory;
			draft.skills = result.skills.map((skill) => summarize(skill, userDirectory));
			draft.diagnostics = result.diagnostics.map((diagnostic) => ({
				message: diagnostic.message,
				...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
			}));
		});
	};

	return {
		service: {
			state: service.state,
			async read(name: string): Promise<string> {
				return readFile(found(name).filePath, "utf8");
			},
			async write(request: { readonly name: string; readonly content: string }, context: Context): Promise<void> {
				const name = requireName(request.name);
				const filePath = join(userDirectory, name, "SKILL.md");
				const { frontmatter } = parseFrontmatter<SkillFrontmatter>(request.content);
				if (typeof frontmatter.name === "string" && frontmatter.name !== name) {
					throw new Error(`Frontmatter name "${frontmatter.name}" does not match "${name}"`);
				}
				requireDescription(frontmatter, filePath);
				await mkdir(dirname(filePath), { recursive: true });
				await writeFile(filePath, request.content.endsWith("\n") ? request.content : `${request.content}\n`, "utf8");
				refresh(context);
			},
			async remove(name: string, context: Context): Promise<void> {
				requireName(name);
				const skill = found(name);
				if (!isInside(userDirectory, skill.filePath) || basename(skill.filePath) !== "SKILL.md") {
					throw new Error(`Skill ${name} is not an agent-directory skill; remove ${skill.filePath} where it lives`);
				}
				await rm(dirname(skill.filePath), { recursive: true, force: true });
				refresh(context);
			},
			async importSkill(path: string, context: Context): Promise<void> {
				const source = resolvePath(path, options.cwd, { trim: true });
				let stats;
				try {
					stats = await stat(source);
				} catch {
					throw new Error(`Skill path does not exist: ${source}`);
				}
				let name: string;
				let copy: () => Promise<void>;
				if (stats.isDirectory()) {
					const skillFile = join(source, "SKILL.md");
					if (!existsSync(skillFile)) throw new Error(`${source} does not contain a SKILL.md`);
					const { frontmatter } = parseFrontmatter<SkillFrontmatter>(await readFile(skillFile, "utf8"));
					requireDescription(frontmatter, skillFile);
					name = requireName(typeof frontmatter.name === "string" ? frontmatter.name : basename(source));
					const target = join(userDirectory, name);
					copy = async () => {
						await mkdir(userDirectory, { recursive: true });
						await cp(source, target, { recursive: true });
					};
				} else if (stats.isFile() && source.endsWith(".md")) {
					const { frontmatter } = parseFrontmatter<SkillFrontmatter>(await readFile(source, "utf8"));
					requireDescription(frontmatter, source);
					name = requireName(typeof frontmatter.name === "string" ? frontmatter.name : basename(source, ".md"));
					const target = join(userDirectory, name, "SKILL.md");
					copy = async () => {
						await mkdir(dirname(target), { recursive: true });
						await cp(source, target);
					};
				} else {
					throw new Error("A skill path must be a directory containing SKILL.md, or a markdown file");
				}
				if (existsSync(join(userDirectory, name))) {
					throw new Error(`A skill named ${name} already exists in ${userDirectory}`);
				}
				await copy();
				refresh(context);
			},
			async reload(context: Context): Promise<void> {
				refresh(context);
			},
		},
		/** Publish the loaded set; the host calls this once the service is reachable. */
		refresh,
	};
}
