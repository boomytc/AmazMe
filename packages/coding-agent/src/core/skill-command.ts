import { readFileSync } from "node:fs";
import { stripFrontmatter } from "../utils/frontmatter.ts";

/** The parts of a loaded skill an expansion needs. */
export interface SkillCommandTarget {
	readonly name: string;
	/** The directory references in the skill's body are relative to. */
	readonly baseDir: string;
	readonly filePath: string;
}

/**
 * The prompt one `/skill:<name>` command becomes: the skill's body in a `<skill>` block, then the
 * reader's arguments. The terminal's prompt path and a hosted session's command surface both call
 * this, so a skill reaches the model in one shape whichever client invoked it.
 */
export function skillCommandPrompt(skill: SkillCommandTarget, args: string): string {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	const trimmed = args.trim();
	return trimmed.length === 0 ? block : `${block}\n\n${trimmed}`;
}
