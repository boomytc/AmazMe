import { existsSync } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Context, MutableReplicatedState } from "@amazme/chord";
import type { FileSystem } from "@amazme/durable/env";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import { withFileMutationQueue } from "@amazme/durable/file-operations";
import type { ResourceLoader } from "../../core/resource-loader.ts";
import type { Skill, SkillFrontmatter } from "../../core/skills.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { SkillSummary, SkillsState } from "./skills.ts";

/** Same rules the Agent Skills spec applies to a skill name. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;

export interface SkillsServiceOptions {
	readonly agentDir: string;
	readonly cwd: string;
	/** The host's selected resources, including package filters and project trust. */
	readonly resources: Pick<ResourceLoader, "getSkills" | "reload">;
}

function requireName(name: string): string {
	if (
		name.length === 0 ||
		name.length > MAX_SKILL_NAME ||
		!SKILL_NAME_PATTERN.test(name)
	) {
		throw new Error(
			`Skill name "${name}" must be lowercase letters, digits, and single hyphens, at most ${MAX_SKILL_NAME} characters`,
		);
	}
	return name;
}

function requireDescription(
	frontmatter: SkillFrontmatter,
	filePath: string,
): void {
	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		throw new Error(`${filePath} needs a description in its frontmatter`);
	}
}

function isInside(directory: string, path: string): boolean {
	const root = resolve(directory);
	const target = resolve(path);
	return (
		target === root ||
		target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
	);
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
 * The host working directory's selected skills. Session workers use the same resource selection
 * rules in their own working directories; this administration surface does not change their owner.
 */
export function createSkillsService(
	options: SkillsServiceOptions,
	createState: (initial: SkillsState) => MutableReplicatedState<SkillsState>,
) {
	const userDirectory = join(options.agentDir, "skills");
	// Needs FileSystem only. Durable does not yet export a file-only Node class; leave construction incomplete
	// until that lands (do not invent a fake artifactDirectory here).
	const files: FileSystem = new NodeExecutionEnv({ cwd: options.cwd });
	// Share the canonical-directory barrier across service instances and path aliases. Reload must
	// see a completed mutation, and cancelling a waiter must not release its predecessor's slot.
	const mutate = <T>(
		context: Context,
		operation: () => Promise<T>,
	): Promise<T> =>
		withFileMutationQueue(files, userDirectory, operation, context);
	const service = {
		state: createState({
			revision: 0,
			directory: userDirectory,
			skills: [],
			diagnostics: [],
		}),
	};
	const found = (name: string): Skill => {
		const skill = options.resources
			.getSkills()
			.skills.find((candidate) => candidate.name === name);
		if (skill === undefined) throw new Error(`Unknown skill: ${name}`);
		return skill;
	};
	const refresh = (context: Context): void => {
		const result = options.resources.getSkills();
		service.state.change(context, (draft) => {
			draft.revision += 1;
			draft.directory = userDirectory;
			draft.skills = result.skills.map((skill) =>
				summarize(skill, userDirectory),
			);
			draft.diagnostics = result.diagnostics.map((diagnostic) => ({
				message: diagnostic.message,
				...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
			}));
		});
	};
	const reload = async (context: Context): Promise<void> => {
		await options.resources.reload();
		refresh(context);
	};

	return {
		service: {
			state: service.state,
			async read(name: string, _context: Context): Promise<string> {
				return readFile(found(name).filePath, "utf8");
			},
			async write(
				request: { readonly name: string; readonly content: string },
				context: Context,
			): Promise<void> {
				const name = requireName(request.name);
				const filePath = join(userDirectory, name, "SKILL.md");
				const content = request.content;
				const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
				if (typeof frontmatter.name === "string" && frontmatter.name !== name) {
					throw new Error(
						`Frontmatter name "${frontmatter.name}" does not match "${name}"`,
					);
				}
				requireDescription(frontmatter, filePath);
				return mutate(context, async () => {
					context.abortSignal?.throwIfAborted();
					await mkdir(dirname(filePath), { recursive: true });
					await writeFile(
						filePath,
						content.endsWith("\n") ? content : `${content}\n`,
						"utf8",
					);
					await reload(context);
				});
			},
			async remove(name: string, context: Context): Promise<void> {
				requireName(name);
				return mutate(context, async () => {
					context.abortSignal?.throwIfAborted();
					const skill = found(name);
					if (
						!isInside(userDirectory, skill.filePath) ||
						basename(skill.filePath) !== "SKILL.md"
					) {
						throw new Error(
							`Skill ${name} is not an agent-directory skill; remove ${skill.filePath} where it lives`,
						);
					}
					await rm(dirname(skill.filePath), { recursive: true, force: true });
					await reload(context);
				});
			},
			async importSkill(path: string, context: Context): Promise<void> {
				const source = resolvePath(path, options.cwd, { trim: true });
				return mutate(context, async () => {
					context.abortSignal?.throwIfAborted();
					let stats;
					try {
						stats = await stat(source);
					} catch {
						throw new Error(`Skill path does not exist: ${source}`);
					}
					const folder = stats.isDirectory();
					if (!folder && !(stats.isFile() && source.endsWith(".md"))) {
						throw new Error(
							"A skill path must be a directory containing SKILL.md, or a markdown file",
						);
					}
					const skillFile = folder ? join(source, "SKILL.md") : source;
					if (folder && !existsSync(skillFile))
						throw new Error(`${source} does not contain a SKILL.md`);
					const content = await readFile(skillFile, "utf8");
					const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
					requireDescription(frontmatter, skillFile);
					const name = requireName(
						typeof frontmatter.name === "string"
							? frontmatter.name
							: basename(source, folder ? undefined : ".md"),
					);
					context.abortSignal?.throwIfAborted();
					await mkdir(userDirectory, { recursive: true });
					const target = join(await realpath(userDirectory), name);
					if (folder && isInside(await realpath(source), target))
						throw new Error("Cannot import a skill into itself");
					context.abortSignal?.throwIfAborted();
					// Exclusive reservation also rejects other processes and dangling symlinks. Never merge
					// an import into a directory another caller already owns.
					try {
						await mkdir(target);
					} catch (error) {
						if (
							typeof error === "object" &&
							error !== null &&
							"code" in error &&
							error.code === "EEXIST"
						) {
							throw new Error(
								`A skill named ${name} already exists in ${userDirectory}`,
							);
						}
						throw error;
					}
					const owned = await lstat(target);
					try {
						if (folder)
							for (const entry of await readdir(source)) {
								if (entry === "SKILL.md") continue;
								await cp(join(source, entry), join(target, entry), {
									recursive: true,
									force: false,
									errorOnExist: true,
									filter: () => {
										context.abortSignal?.throwIfAborted();
										return true;
									},
								});
							}
						context.abortSignal?.throwIfAborted();
						// Publish the validated manifest last; a partial asset copy is not an active skill.
						await writeFile(join(target, "SKILL.md"), content, {
							encoding: "utf8",
							flag: "wx",
							signal: context.abortSignal,
						});
					} catch (error) {
						try {
							const current = await lstat(target).catch((failure: unknown) => {
								if (
									typeof failure === "object" &&
									failure !== null &&
									"code" in failure &&
									failure.code === "ENOENT"
								)
									return undefined;
								throw failure;
							});
							if (current?.dev === owned.dev && current.ino === owned.ino)
								await rm(target, { recursive: true, force: true });
						} catch (cleanup) {
							throw new AggregateError(
								[error, cleanup],
								"Skill import and cleanup failed",
							);
						}
						throw error;
					}
					// A failed reload does not undo an already published skill.
					await reload(context);
				});
			},
			async reload(context: Context): Promise<void> {
				return mutate(context, () => reload(context));
			},
		},
		/** Publish the loaded set; the host calls this once the service is reachable. */
		refresh,
	};
}
