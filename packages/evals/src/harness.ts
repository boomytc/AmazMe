import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, chown, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { contentText, InMemoryCredentialStore, type AssistantMessage, type Message } from "@amazme/ai";
import { getCurrentSystemPrompt } from "@amazme/ai/utils/transcript";
import {
	buildSystemPrompt,
	createDurableSession,
	type DurableSession,
	getAgentDir,
	ModelRuntime,
	readStoredCredential,
} from "@amazme/coding-agent";
import {
	attachHarnessRunToError,
	createHarness,
	type Harness,
	type HarnessContext,
	type JsonValue,
	normalizeHarnessRun,
	normalizeRecord,
	type SimpleHarnessResult,
	type TranscriptEvent,
	toJsonValue,
	type UsageSummary,
} from "vitest-evals/harness";
import type { DocumentationVariant } from "./plan.ts";
import { AMAZME_SESSION_SNAPSHOT_ARTIFACT } from "./report.ts";

type RunDiagnostics = {
	events: TranscriptEvent[];
	metadata: Record<string, unknown>;
	usage: UsageSummary;
};

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

async function chownTree(path: string, identity: SandboxIdentity): Promise<void> {
	const stats = await lstat(path);
	if (stats.isDirectory() && !stats.isSymbolicLink()) {
		await Promise.all((await readdir(path)).map((entry) => chownTree(join(path, entry), identity)));
	}
	await chown(path, identity.uid, identity.gid);
}

async function protectTransformedModules(): Promise<string[]> {
	const protectedPaths: string[] = [];
	for (const directory of await readdir(tmpdir(), { withFileTypes: true })) {
		if (!directory.isDirectory()) continue;
		const cacheRoot = join(tmpdir(), directory.name);
		const ssrRoot = join(cacheRoot, "ssr");
		let files: Dirent[];
		try {
			files = await readdir(ssrRoot, { withFileTypes: true });
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		await Promise.all([chmod(cacheRoot, 0o755), chmod(ssrRoot, 0o755)]);
		for (const file of files) {
			if (!file.isFile()) continue;
			const path = join(ssrRoot, file.name);
			await chmod(path, 0o600);
			protectedPaths.push(path);
		}
	}
	return protectedPaths;
}

async function enterToolSandbox(root: string, identity: SandboxIdentity | undefined): Promise<void> {
	if (!identity) return;
	if (
		typeof process.getuid !== "function" ||
		typeof process.geteuid !== "function" ||
		typeof process.setuid !== "function" ||
		typeof process.setgid !== "function" ||
		typeof process.setgroups !== "function"
	) {
		throw new Error("The eval filesystem sandbox requires POSIX user APIs.");
	}
	if (process.getuid() !== 0 || process.geteuid() !== 0) {
		throw new Error("The eval runner must start as root before entering the unprivileged tool sandbox.");
	}

	const protectedPaths = await protectTransformedModules();
	await chownTree(root, identity);
	process.setgroups([]);
	process.setgid(identity.gid);
	process.setuid(identity.uid);
	if (process.getuid() !== identity.uid || process.geteuid() !== identity.uid) {
		throw new Error("Failed to enter the unprivileged eval tool sandbox.");
	}
	for (const path of protectedPaths) {
		try {
			await readFile(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "ENOENT")) {
				continue;
			}
			throw error;
		}
		throw new Error(`The unprivileged eval process can read a transformed eval module: ${path}`);
	}
}

function toTranscriptEvents(messages: readonly Message[]): TranscriptEvent[] {
	const events: TranscriptEvent[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			events.push({ type: "message", role: "user", content: contentText(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const text = contentText(message.content);
			if (text) events.push({ type: "message", role: "assistant", content: text });
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				events.push({
					type: "tool_call",
					id: part.id,
					name: part.name,
					arguments: normalizeRecord(part.arguments),
				});
			}
			continue;
		}
		if (message.role === "toolResult") {
			const text = contentText(message.content);
			events.push({
				type: "tool_result",
				toolCallId: message.toolCallId,
				name: message.toolName,
				content: message.content.every((part) => part.type === "text") ? text : toJsonValue(message.content),
				...(message.isError ? { error: { message: text || "Tool failed" } } : {}),
			});
		}
	}
	return events;
}

async function seedWorkspace(workspace: string, files: Readonly<Record<string, string>> | undefined): Promise<void> {
	for (const [name, content] of Object.entries(files ?? {})) {
		if (!name || isAbsolute(name)) throw new TypeError(`Invalid workspace fixture path: ${name}`);
		const path = resolve(workspace, name);
		const pathFromWorkspace = relative(workspace, path);
		if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
			throw new TypeError(`Workspace fixture escapes the workspace: ${name}`);
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, { mode: 0o600 });
	}
}

function assistantText(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function promptAgent(session: DurableSession, input: string, signal: AbortSignal | undefined): Promise<string> {
	signal?.throwIfAborted();
	const assistant = await session.prompt(input);
	if (!assistant) throw new Error("Agent run completed without an assistant message.");
	if (assistant.stopReason !== "stop" && assistant.stopReason !== "toolUse") {
		throw new Error(
			assistant.errorMessage ?? `Agent run ended with unexpected stop reason: ${assistant.stopReason}.`,
		);
	}
	const output = assistantText(assistant);
	if (!output && assistant.stopReason === "stop") throw new Error("Agent run produced no assistant text.");
	return output;
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
	input: CodingAgentInput,
	signal: AbortSignal | undefined,
	setArtifact: HarnessContext["setArtifact"],
	options: CodingAgentHarnessOptions | CodingAgentHarnessWithOutput<TOutput>,
): Promise<SimpleHarnessResult<string | TOutput>> {
	const startedAt = performance.now();
	signal?.throwIfAborted();
	const selection = resolveModelSelection(options.model);
	const hostAgentDir = getAgentDir();
	const sandboxIdentity = resolveSandboxIdentity();
	const root = await mkdtemp(join(tmpdir(), "amazme-eval-"));
	const workspace = join(root, "workspace");
	const isolatedHome = join(root, "home");
	const agentDir = join(isolatedHome, ".amazme", "agent");
	const forcedSystemPrompt = options.transformSystemPrompt?.(
		buildSystemPrompt({
			cwd: workspace,
			selectedTools: [...(options.tools ?? [])],
		}),
	);

	let session: DurableSession | undefined;
	let result: SimpleHarnessResult<string | TOutput> | undefined;
	let runDiagnostics: RunDiagnostics | undefined;
	let runError: unknown;
	const cleanupErrors: unknown[] = [];
	let hiddenCredentialEnvironment: { name: string; value: string } | undefined;
	const restoreEnvironment = applyIsolatedEnvironment(isolatedHome, agentDir);
	try {
		const authPath = join(hostAgentDir, "auth.json");
		const credentials = new InMemoryCredentialStore();
		const storedCredential = readStoredCredential(selection.provider, authPath);
		if (storedCredential) await credentials.modify(selection.provider, async () => storedCredential);
		const modelRuntime = await ModelRuntime.create({ credentials });
		await Promise.all([mkdir(workspace), mkdir(agentDir, { recursive: true })]);
		await seedWorkspace(workspace, options.workspaceFiles);
		const model = modelRuntime.getModel(selection.provider, selection.id);
		if (!model) throw new Error(`Eval model not found: ${selection.provider}/${selection.id}`);
		const auth = await modelRuntime.getAuth(model);
		if (!auth) {
			throw new Error(`Eval model has no configured authentication: ${selection.provider}/${selection.id}`);
		}
		if (!storedCredential && auth.auth.apiKey) {
			await modelRuntime.setRuntimeApiKey(selection.provider, auth.auth.apiKey);
		}
		if (sandboxIdentity) {
			await rm(authPath, { force: true });
			const credentialEnvironmentValue = auth.source ? process.env[auth.source] : undefined;
			if (auth.source && /^[A-Z][A-Z0-9_]*$/.test(auth.source) && credentialEnvironmentValue) {
				hiddenCredentialEnvironment = { name: auth.source, value: credentialEnvironmentValue };
				delete process.env[auth.source];
			}
		}

		signal?.throwIfAborted();
		session = await createDurableSession({
			cwd: workspace,
			modelRuntime,
			provider: selection.provider,
			model: selection.id,
			thinkingLevel: "off",
			...(options.tools === undefined ? {} : { tools: options.tools }),
			...(options.noTools === undefined ? {} : { noTools: options.noTools }),
			...(forcedSystemPrompt === undefined ? {} : { systemPrompt: forcedSystemPrompt }),
			noExtensions: true,
			noSession: true,
		});
		setArtifact("runId", session.id);

		await enterToolSandbox(root, sandboxIdentity);
		let response: string | undefined;
		const steps = typeof input === "string" ? [{ type: "prompt" as const, content: input }] : input;
		let abortPromise: Promise<void> | undefined;
		const abort = () => {
			abortPromise ??= session!.abort();
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			for (const step of steps) {
				response = await promptAgent(session, step.content, signal);
			}
		} finally {
			signal?.removeEventListener("abort", abort);
			if (abortPromise) await abortPromise;
		}
		if (response === undefined) {
			throw new Error("AmazMe eval input must include at least one prompt step.");
		}
		const messages = session.messages();
		const systemPrompt = forcedSystemPrompt ?? getCurrentSystemPrompt(messages);
		const usage = messages.reduce(
			(total, message) => {
				if (message.role !== "assistant") return total;
				total.toolCalls += message.content.filter((part) => part.type === "toolCall").length;
				if (message.usage === undefined) return total;
				total.input += message.usage.input;
				total.output += message.usage.output;
				total.cacheRead += message.usage.cacheRead;
				total.cacheWrite += message.usage.cacheWrite;
				total.total += message.usage.totalTokens;
				total.cost += message.usage.cost.total;
				return total;
			},
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, toolCalls: 0 },
		);
		const hasPricing = [model.cost, ...(model.cost.tiers ?? [])].some(
			({ input: inputCost, output: outputCost, cacheRead, cacheWrite }) =>
				inputCost > 0 || outputCost > 0 || cacheRead > 0 || cacheWrite > 0,
		);
		runDiagnostics = {
			events: toTranscriptEvents(messages),
			metadata: { systemPromptSha256: createHash("sha256").update(systemPrompt).digest("hex") },
			usage: {
				provider: model.provider,
				model: model.id,
				inputTokens: usage.input,
				outputTokens: usage.output,
				totalTokens: usage.total,
				toolCalls: usage.toolCalls,
				metadata: {
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					...(hasPricing ? { estimatedCostUsd: usage.cost } : {}),
				},
			},
		};
		verifySystemPrompt(systemPrompt, options);
		const output =
			"output" in options ? await options.output({ response, session, systemPrompt, agentDir }) : response;
		result = { output, ...runDiagnostics };
	} catch (error) {
		runError = error;
	} finally {
		if (session) {
			try {
				setArtifact(AMAZME_SESSION_SNAPSHOT_ARTIFACT, JSON.stringify(session.messages()));
			} catch (error) {
				cleanupErrors.push(error);
			}
			try {
				await session.dispose();
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		try {
			await rm(root, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}
		restoreEnvironment();
		if (hiddenCredentialEnvironment) {
			process.env[hiddenCredentialEnvironment.name] = hiddenCredentialEnvironment.value;
		}
	}

	let failure = runError;
	if (runError !== undefined && cleanupErrors.length > 0) {
		failure = new AggregateError([runError, ...cleanupErrors], "Agent run failed and cleanup also failed.");
	} else if (cleanupErrors.length === 1) {
		failure = cleanupErrors[0];
	} else if (cleanupErrors.length > 1) {
		failure = new AggregateError(cleanupErrors, "Agent cleanup failed.");
	}
	if (failure !== undefined) {
		if (runDiagnostics) {
			const partialRun = normalizeHarnessRun(input, {
				...runDiagnostics,
				errors: [failure],
				timings: { totalMs: performance.now() - startedAt },
			});
			throw attachHarnessRunToError(failure, partialRun);
		}
		throw failure;
	}
	if (!result) throw new Error("AmazMe eval completed without a result.");
	return { ...result, timings: { totalMs: performance.now() - startedAt } };
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
