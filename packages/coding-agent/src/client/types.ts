/** Values shared by the CLI's headless and interactive Python clients. */

export interface ImageContent {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface PythonResourceOptions {
	readonly no_context_files?: boolean;
	readonly no_skills?: boolean;
	readonly skill_paths?: readonly string[];
	readonly no_prompt_templates?: boolean;
	readonly prompt_paths?: readonly string[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface PythonRunOptions {
    readonly model_selection?: {readonly provider:string; readonly model:string};
    readonly thinking?: ThinkingLevel;
	readonly resource_options?: PythonResourceOptions;
	readonly system_prompt?: string;
	readonly append_system_prompt?: string;
	readonly allowed_tools?: readonly string[];
	readonly excluded_tools?: readonly string[];
}

export interface PythonModelOptions {
	readonly modelPatterns?: readonly string[];
	readonly modelRef?: string;
	readonly provider?: string;
}

export interface SessionSummary {
	readonly session_id: string;
	readonly title: string;
	readonly workspace: string;
	readonly archived: boolean;
}

export interface OpenedSession {
	readonly sessionId: string;
	readonly attachmentId: string;
}

export interface Polled {
	readonly receipt: Record<string, unknown>;
	readonly approval?: Record<string, unknown>;
}
