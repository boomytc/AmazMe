import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import { skillCommandPrompt } from "./skill-command.ts";
import type { Skill } from "./skills.ts";

export interface CommandResources {
	readonly templates: readonly PromptTemplate[];
	readonly skills: readonly Skill[];
}

export type CommandExpansion =
	| { readonly ok: true; readonly prompt: string }
	| { readonly ok: false; readonly problem: string };

/** Native and hosted inputs use the SDK's expansion functions; callers own submission and its target. */
export function expandResourceCommand(resources: CommandResources, name: string, args: string): CommandExpansion {
	if (name.startsWith("skill:")) {
		const skill = resources.skills.find((candidate) => candidate.name === name.slice("skill:".length));
		if (skill === undefined) return { ok: false, problem: `Unknown skill: ${name.slice("skill:".length)}` };
		try {
			return { ok: true, prompt: skillCommandPrompt(skill, args) };
		} catch (error) {
			return { ok: false, problem: error instanceof Error ? error.message : String(error) };
		}
	}
	const template = resources.templates.find((candidate) => candidate.name === name);
	if (template === undefined) return { ok: false, problem: `Unknown command: /${name}` };
	const line = args.length === 0 ? `/${name}` : `/${name} ${args}`;
	return { ok: true, prompt: expandPromptTemplate(line, [template]) };
}
