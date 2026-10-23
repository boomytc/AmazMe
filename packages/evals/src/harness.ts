import type { DurableSession } from "@amazme/coding-agent";
import {
	createHarness,
	type Harness,
	type HarnessContext,
	type JsonValue,
	type SimpleHarnessResult,
} from "vitest-evals/harness";
import type { DocumentationVariant } from "./plan.ts";

export type CodingAgentInput = string | Array<{ type: "prompt"; content: string }>;

export type CodingAgentModelSelection = {
	provider: string;
	id: string;
};

export type CodingAgentHarnessOptions = {
	name?: string;
	model?: CodingAgentModelSelection;
	noTools?: "all" | "builtin";
	tools?: readonly string[];
	workspaceFiles?: Readonly<Record<string, string>>;
	transformSystemPrompt?: (defaultPrompt: string) => string;
	expectedDocumentation?: boolean;
};

export type CodingAgentHarnessWithOutput<TOutput extends JsonValue> = CodingAgentHarnessOptions & {
	output: (args: {
		response: string;
		session: DurableSession;
		systemPrompt: string;
		agentDir: string;
	}) => TOutput | Promise<TOutput>;
};

export function resolveModelSelection(
	explicitModel: CodingAgentModelSelection | undefined,
	environment: { AMAZME_PROVIDER?: string; AMAZME_MODEL?: string } = process.env,
): CodingAgentModelSelection {
	const provider = (explicitModel?.provider ?? environment.AMAZME_PROVIDER)?.trim();
	const id = (explicitModel?.id ?? environment.AMAZME_MODEL)?.trim();
	if (!provider || !id) {
		throw new Error("Select a harness model explicitly or set both AMAZME_PROVIDER and AMAZME_MODEL as defaults.");
	}
	return { provider, id };
}

export function applyIsolatedEnvironment(home: string, agentDir: string): () => void {
	const overrides = { HOME: home, USERPROFILE: home, AMAZME_CODING_AGENT_DIR: agentDir };
	const previous = new Map<string, string | undefined>();
	for (const name of Object.keys(process.env)) {
		if (!name.startsWith("AMAZME_EVAL_")) continue;
		previous.set(name, process.env[name]);
		delete process.env[name];
	}
	for (const [name, value] of Object.entries(overrides)) {
		if (!previous.has(name)) previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

type SandboxIdentity = { uid: number; gid: number };

function parseSandboxId(name: "AMAZME_EVAL_SANDBOX_UID" | "AMAZME_EVAL_SANDBOX_GID"): number | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	const id = Number(value);
	if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${name} must be a positive integer.`);
	return id;
}

function resolveSandboxIdentity(): SandboxIdentity | undefined {
	const uid = parseSandboxId("AMAZME_EVAL_SANDBOX_UID");
	const gid = parseSandboxId("AMAZME_EVAL_SANDBOX_GID");
	if (uid === undefined && gid === undefined) return undefined;
	if (uid === undefined || gid === undefined) {
		throw new Error("Set both AMAZME_EVAL_SANDBOX_UID and AMAZME_EVAL_SANDBOX_GID, or neither.");
	}
	return { uid, gid };
}

export function verifySystemPrompt(
	systemPrompt: string,
	options: Pick<CodingAgentHarnessOptions, "name" | "expectedDocumentation">,
): string {
	if (options.expectedDocumentation === undefined) return systemPrompt;
	if (!systemPrompt.includes("\n<rules>\n")) {
		throw new Error(`AmazMe system prompt lost its rules in the ${options.name} eval variant.`);
	}
	const hasDocumentation = systemPrompt.includes("\n<docs>\nAmazMe documentation (read only");
	if (hasDocumentation !== options.expectedDocumentation) {
		throw new Error(`AmazMe system prompt does not match the ${options.name} eval variant.`);
	}
	return systemPrompt;
}

async function runCodingAgent<TOutput extends JsonValue>(
	_input: CodingAgentInput,
	_signal: AbortSignal | undefined,
	_setArtifact: HarnessContext["setArtifact"],
	_options: CodingAgentHarnessOptions | CodingAgentHarnessWithOutput<TOutput>,
): Promise<SimpleHarnessResult<string | TOutput>> {
	throw new Error("old_session_runtime_removed\n会话由 Python 后端提供，不再创建旧 durable 会话");
}

export function createCodingAgentHarness<TOutput extends JsonValue>(
	options: CodingAgentHarnessWithOutput<TOutput>,
): Harness<CodingAgentInput, TOutput>;
export function createCodingAgentHarness(options?: CodingAgentHarnessOptions): Harness<CodingAgentInput, string>;
export function createCodingAgentHarness<TOutput extends JsonValue>(
	options: CodingAgentHarnessOptions | CodingAgentHarnessWithOutput<TOutput> = {},
): Harness<CodingAgentInput, string | TOutput> {
	return createHarness<CodingAgentInput, string | TOutput>({
		name: options.name ?? "@amazme/coding-agent",
		run: ({ input, signal, setArtifact }) => runCodingAgent(input, signal, setArtifact, options),
	});
}

/** Documentation evals intentionally exclude shell and unrestricted network tools. */
export const DOCUMENTATION_EVAL_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

export function resolveDocumentationVariant(
	value: string | undefined = process.env.AMAZME_EVAL_VARIANT,
): DocumentationVariant {
	if (value === "without_docs" || value === "with_docs") return value;
	throw new TypeError('AMAZME_EVAL_VARIANT must be "without_docs" or "with_docs".');
}

export function excludeDocumentation(defaultPrompt: string): string {
	const documentationStartMarker = "\n<docs>\n";
	const documentationEndMarker = "\n</docs>";
	const documentationStart = defaultPrompt.indexOf(documentationStartMarker);
	if (documentationStart === -1) throw new Error("Default AmazMe system prompt has no AmazMe documentation section.");
	const documentationEnd = defaultPrompt.indexOf(documentationEndMarker, documentationStart);
	if (documentationEnd === -1) throw new Error("Default AmazMe system prompt has no complete AmazMe documentation section.");
	const cwdStart = defaultPrompt.lastIndexOf("\n<cwd>\n");
	if (cwdStart < documentationEnd) throw new Error("Default AmazMe system prompt has no working-directory section.");
	return (
		defaultPrompt.slice(0, documentationStart) + defaultPrompt.slice(documentationEnd + documentationEndMarker.length)
	);
}

type DocumentationHarnessOptions = Omit<
	CodingAgentHarnessOptions,
	"name" | "transformSystemPrompt" | "expectedDocumentation"
>;
type DocumentationHarnessWithOutput<TOutput extends JsonValue> = Omit<
	CodingAgentHarnessWithOutput<TOutput>,
	"name" | "transformSystemPrompt" | "expectedDocumentation"
>;

export function createDocumentationEvalHarness<TOutput extends JsonValue>(
	options: DocumentationHarnessWithOutput<TOutput>,
): Harness<CodingAgentInput, TOutput>;
export function createDocumentationEvalHarness(
	options?: DocumentationHarnessOptions,
): Harness<CodingAgentInput, string>;
export function createDocumentationEvalHarness<TOutput extends JsonValue>(
	options: DocumentationHarnessOptions | DocumentationHarnessWithOutput<TOutput> = {},
) {
	if (process.env.AMAZME_EVAL_CONTAINER !== "1" || !resolveSandboxIdentity()) {
		throw new Error("Documentation evals must run in the isolated container sandbox.");
	}
	const variant = resolveDocumentationVariant();
	return createCodingAgentHarness({
		...options,
		name: variant,
		tools: options.tools ?? [...DOCUMENTATION_EVAL_TOOLS],
		...(variant === "without_docs" ? { transformSystemPrompt: excludeDocumentation } : {}),
		expectedDocumentation: variant === "with_docs",
	});
}
