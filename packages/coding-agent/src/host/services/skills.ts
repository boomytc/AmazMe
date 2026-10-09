import { type Context, defineService, type ReplicatedState } from "@amazme/chord";

/** One loaded skill, as the management surface lists it. */
export interface SkillSummary {
	name: string;
	description: string;
	/** The `SKILL.md` (or markdown file) the skill was loaded from. */
	filePath: string;
	/** `user` for the agent directory, `project` for the workspace, `temporary` for a configured path. */
	scope: "user" | "project" | "temporary";
	/** Whether the skill is withheld from the model prompt and only reachable by command. */
	disableModelInvocation: boolean;
	/** The agent directory owns the file, so this surface may edit or remove it. */
	editable: boolean;
}

export interface SkillDiagnostic {
	message: string;
	path?: string;
}

export interface SkillsState {
	revision: number;
	/** The directory new and edited skills are written to. */
	directory: string;
	skills: SkillSummary[];
	diagnostics: SkillDiagnostic[];
}

export interface SkillWriteRequest {
	readonly name: string;
	/** The whole `SKILL.md`, frontmatter included. */
	readonly content: string;
}

/** The agent's skills: list them, and edit the ones the agent directory owns. */
export interface Skills {
	readonly state: ReplicatedState<SkillsState>;
	read(name: string, context: Context): Promise<string>;
	write(request: SkillWriteRequest, context: Context): Promise<void>;
	remove(name: string, context: Context): Promise<void>;
	/** Copy a skill directory or markdown file into the agent's skills directory. */
	importSkill(path: string, context: Context): Promise<void>;
	reload(context: Context): Promise<void>;
}

export const Skills = defineService<Skills>("amazme.skills");
