import { defineExtension, type PromptInput, section } from "@amazme/durable";
import type { ResourceLoader } from "../core/resource-loader.ts";
import { buildSystemPromptSections } from "../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../core/tools/edit.ts";
import { findToolSystemPromptContribution } from "../core/tools/find.ts";
import { grepToolSystemPromptContribution } from "../core/tools/grep.ts";
import { lsToolSystemPromptContribution } from "../core/tools/ls.ts";
import { powershellToolSystemPromptContribution } from "../core/tools/powershell.ts";
import { readToolSystemPromptContribution } from "../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../core/tools/write.ts";

const CONTRIBUTIONS = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
	grep: grepToolSystemPromptContribution,
	find: findToolSystemPromptContribution,
	ls: lsToolSystemPromptContribution,
	powershell: powershellToolSystemPromptContribution,
};

/** pi's section order; `buildSystemPromptSections()` omits the ones without content. */
const KEYS = ["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"] as const;

export interface CodingResourceOptions {
	readonly systemPrompt?: string;
	readonly appendSystemPrompt?: readonly string[];
	readonly skills?: readonly string[];
	readonly noSkills?: boolean;
	readonly noContextFiles?: boolean;
	readonly promptTemplates?: readonly string[];
	readonly noPromptTemplates?: boolean;
	readonly themes?: readonly string[];
	readonly noThemes?: boolean;
}

type PromptResources = Pick<ResourceLoader, "getSystemPrompt" | "getAppendSystemPrompt" | "getAgentsFiles" | "getSkills">;

/**
 * pi's system prompt as one extension: the sections of `buildSystemPromptSections()` for the request's tools and the
 * conversation's directory. All resource selection and reloads belong to the shared resource loader.
 */
export function createPiPrompt(resources: PromptResources, fallbackCwd: string) {
	// The sections of one request render from one build.
	const built = new WeakMap<PromptInput, Record<string, string>>();
	const build = (input: PromptInput): Record<string, string> => {
		let sections = built.get(input);
		if (sections === undefined) {
			sections = buildSections(input);
			built.set(input, sections);
		}
		return sections;
	};
	const buildSections = (input: PromptInput): Record<string, string> => {
		const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
		const selectedTools = input.agent.tools.map((tool) => tool.name);
		const snippets: Record<string, string> = {};
		const guidelines: Record<string, string[]> = {};
		for (const name of selectedTools) {
			const contribution = CONTRIBUTIONS[name as keyof typeof CONTRIBUTIONS];
			if (contribution === undefined) continue;
			snippets[name] = contribution.snippet;
			guidelines[name] = [...contribution.guidelines];
		}
		return buildSystemPromptSections({
			cwd,
			selectedTools,
			toolSnippets: snippets,
			toolGuidelines: guidelines,
			customPrompt: resources.getSystemPrompt(),
			appendSystemPrompt: resources.getAppendSystemPrompt().join("\n\n"),
			contextFiles: resources.getAgentsFiles().agentsFiles,
			skills: resources.getSkills().skills,
		});
	};
	return defineExtension({
		name: "pi-prompt",
		// The built sections carry their own tags.
		sections: KEYS.map((key) => section(key, (input) => build(input)[key], { tag: false })),
	});
}
