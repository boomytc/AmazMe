import { randomUUID } from "node:crypto";
import { Type } from "@amazme/ai";
import { defineFacet } from "@amazme/chord";
import type { Context, JsonValue } from "@amazme/chord";
import { withoutAbortSignal } from "@amazme/chord/context";
import { AgentExtensions, AgentRuntime, SlashCommands } from "@amazme/coding-agent/plugin";
import { defineExtension, defineTool, ToolTask } from "@amazme/durable";
import type { TaskId, ToolExecutionApi } from "@amazme/durable";
import { listTemplates, loadTemplate, saveTemplate } from "./files.ts";
import { Job } from "./job.ts";
import type { JobResult } from "./job.ts";
import { PlanSchema, readPlan } from "./plan.ts";
import { Run } from "./run.ts";
import type { RunInput } from "./run.ts";
import { Admission, Control, Index } from "./state.ts";
import type { RunResult, State } from "./state.ts";

const Parameters = Type.Object(
	{
		action: Type.Union(
			["run", "list", "status", "pause", "resume", "stop", "load", "templates"].map((value) => Type.Literal(value)),
		),
		plan: Type.Optional(PlanSchema),
		path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		runId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*$" })),
		args: Type.Optional(Type.String({ maxLength: 16000 })),
	},
	{ additionalProperties: false },
);

async function describe(api: ToolExecutionApi, id: TaskId<RunResult>, context: Context) {
	const record = await api.getTask(id, context);
	if (record?.kind !== Run.definition.name || record.version !== Run.definition.version)
		throw new Error("Workflow run is unavailable or uses another definition version");
	const input = record.input as RunInput,
		state = record.state.checkpoint as State | undefined;
	const result = record.state.outcome?.result ?? (state?.phase === "publish" ? state.result : undefined);
	const paused = (await api.snapshot(Control, id, context))?.paused === true;
	const jobs = [...(result?.jobs ?? (state?.phase !== "publish" ? state?.jobs : undefined) ?? [])];
	const active = state !== undefined && state.phase !== "publish" ? state.active : [];
	let unsettled = 0;
	for (const item of active) {
		const child = await api.getTask(item.task, context);
		if (child?.state.status === "terminal" && child.state.outcome.result !== undefined)
			jobs.push(child.state.outcome.result);
		if (child?.state.status !== "terminal") unsettled++;
	}
	const stages = input.plan.stages.map((stage, index) => ({
		name: stage.name,
		role: stage.role,
		total: stage.jobs.length,
		settled: jobs.filter((job) => job.stage === index).length,
		active: active.filter(
			(item) => item.stage === index && !jobs.some((job) => job.stage === item.stage && job.job === item.job),
		).length,
	}));
	const value = {
		runId: id,
		name: input.plan.name,
		conversationId: record.conversationId,
		state:
			result?.status ??
			(record.state.status === "terminal"
				? record.state.outcome.status === "aborted"
					? "cancelled"
					: "failed"
				: paused
					? unsettled > 0
						? "pausing"
						: "paused"
					: record.state.status),
		phase: state?.phase ?? null,
		stages,
		jobs,
		verification: result?.verification ?? "unverified",
		error: record.state.outcome?.error?.message ?? record.state.outcome?.reason ?? null,
	};
	const text = [
		`Workflow ${value.name} #${id}: ${value.state}. Configured command verification: ${value.verification}.`,
		...stages.map(
			(stage, index) =>
				`${index + 1}. ${stage.name} (${stage.role}): ${stage.settled}/${stage.total} settled; ${stage.active} active`,
		),
		...jobs.map(
			(job) =>
				`${job.name} (${job.kind}) #${job.task}: ${job.status}; tokens ${job.tokens}; entry ${job.entry ?? "none"}; conversation ${job.conversation ?? "none"}${job.limited ? "; output limited" : ""}\n${job.text}`,
		),
		value.error ?? "",
	]
		.filter(Boolean)
		.join("\n");
	return { value, text };
}

/** Configuration/control and execution use the same tool boundary in the CLI and Session worker. */
export function workflowExtension(local: AgentRuntime) {
	return defineExtension({
		name: "workflows",
		tasks: [Run, Job],
		tools: [
			defineTool({
				name: "workflow_save",
				replay: "unsafe",
				annotations: { readOnlyHint: false, destructiveHint: true },
				parameters: Type.Object(
					{
						plan: PlanSchema,
						path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
						expectedVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
					},
					{ additionalProperties: false },
				),
				description:
					"Save an explicit workflow plan for reuse. Create without replacement, or replace only with the version returned by workflow load. Only save when the user asks. An interrupted publication is not automatically repeated; inspect the file with workflow load.",
				async execute(args, api, context) {
					if (api.env === undefined) throw new Error("Workflow templates require a file environment");
					const plan = readPlan(args.plan),
						path = args.path ?? `.amazme/workflows/${plan.name}.json`;
					const value = await saveTemplate(api.env, path, plan, args.expectedVersion, context);
					return {
						content: [{ type: "text", text: JSON.stringify(value) }],
						structuredContent: value,
					};
				},
			}),
			defineTool({
				name: "workflow",
				parameters: Parameters,
				replay: "safe",
				description:
					"Run an explicit bounded staged plan in background, inspect independent job evidence, pause new admission, resume or stop owned work. Load saved JSON plans for reuse; workflow_save publishes templates. Agent answers are reports, not command verification. Never start a workflow unless the user asks. Commands are literal and do not interpolate args. Jobs cannot delegate further. Pause lets in-flight jobs finish; stop cancels and joins them.",
				async execute(args, api, context) {
					let value: JsonValue, text: string;
					if (args.action === "templates") {
						if (api.env === undefined) throw new Error("Workflow templates require a file environment");
						value = await listTemplates(api.env, args.path ?? ".amazme/workflows", context);
						text = JSON.stringify(value);
					} else if (args.action === "load") {
						if (api.env === undefined) throw new Error("Workflow templates require a file environment");
						if (args.path === undefined) throw new Error("Loading requires a template path");
						value = await loadTemplate(api.env, args.path, context);
						text = JSON.stringify(value);
					} else if (args.action === "list") {
						value = { runs: (await api.snapshot(Index, context))?.runs ?? [] };
						text = JSON.stringify(value);
					} else {
						let id: TaskId<RunResult>;
						if (args.action === "run") {
							const accepted = (await api.snapshot(Admission, api.taskId, context))?.run;
							if (accepted !== undefined && accepted !== null) {
								const report = await describe(api, accepted, context);
								return {
									content: [{ type: "text", text: report.text }],
									structuredContent: report.value,
									isError: report.value.state === "failed" || report.value.state === "cancelled",
								};
							}
							if (args.plan !== undefined && args.path !== undefined)
								throw new Error("Give either a plan or template path, not both");
							const plan =
								args.plan === undefined
									? api.env !== undefined && args.path !== undefined
										? (await loadTemplate(api.env, args.path, context)).plan
										: undefined
									: readPlan(args.plan);
							if (plan === undefined) throw new Error("Running requires an explicit plan or template path");
							const agent = await api.agent(context),
								allowed = agent.callableTools
									.map((tool) => tool.name)
									.filter((name) => name !== "subagent" && name !== "workflow" && name !== "workflow_save");
							if (
								plan.stages.some((stage) =>
									stage.jobs.some((job) =>
										job.kind === "agent"
											? job.tools.some((name) => !allowed.includes(name))
											: !allowed.includes(job.tool),
									),
								)
							)
								throw new Error("Plan requests an unavailable tool");
							if (
								agent.model === undefined &&
								plan.stages.some((stage) => stage.jobs.some((job) => job.kind === "agent"))
							)
								throw new Error("Agent jobs require a selected model");
							id = await api.commit(async (tx) => {
								const live: TaskId[] = [];
								for (const status of ["pending", "running", "waiting", "completing"] as const)
									live.push(
										...(await tx.scanTasks({ kind: Run.definition.name, status }, 5)).items.map((task) => task.id),
									);
								const admission = await tx.doc(Admission, api.taskId);
								if (admission.run !== null) return admission.run;
								if (live.length >= 4) throw new Error("Four workflows are already active in this Session");
								const task = await tx.createTask(
									Run,
									{
										plan,
										args: args.args ?? "",
										model:
											agent.model === undefined
												? null
												: {
														provider: agent.model.provider,
														modelId: agent.model.modelId,
													},
										instructions: agent.instructions ?? "",
										allowed,
									},
									{
										ownership: { kind: "conversation" },
										conversationId: api.conversationId,
										background: true,
									},
								);
								await tx.doc(Control, task);
								admission.run = task;
								const index = await tx.doc(Index);
								index.runs.push({
									task,
									conversation: api.conversationId,
									name: plan.name,
									at: Date.now(),
								});
								while (index.runs.length > 20) {
									const oldest = index.runs.findIndex((item) => !live.includes(item.task));
									if (oldest < 0) break;
									index.runs.splice(oldest, 1);
								}
								return task;
							}, context);
						} else {
							const number = Number(args.runId);
							if (!Number.isSafeInteger(number) || number <= 0)
								throw new Error("This action requires a workflow runId");
							id = number as TaskId<RunResult>;
							await describe(api, id, context);
							if (args.action === "pause" || args.action === "resume")
								await api.commit(async (tx) => {
									const record = await tx.task(id);
									const invocation = await tx.doc(Admission, api.taskId);
									if (invocation.controlApplied) return;
									if (record?.state.status !== "terminal" && record?.abortRequested !== true)
										(await tx.doc(Control, id)).paused = args.action === "pause";
									invocation.controlApplied = true;
								}, context);
							if (args.action === "stop") {
								const { harness } = await local.current(context);
								const cleanup = withoutAbortSignal(context);
								await harness.abortTask(id, cleanup);
								await harness.waitForTask(id, cleanup);
							}
						}
						const report = await describe(api, id, context);
						value = report.value;
						text = report.text;
					}
					const failed =
						value !== null &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						(value.state === "failed" || value.state === "cancelled");
					return {
						content: [{ type: "text", text }],
						structuredContent: value,
						isError: (args.action === "run" || args.action === "status") && failed,
					};
				},
			}),
		],
	});
}

function commandArgs(text: string): JsonValue {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonValue;
	const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (match === null) return { action: "list" };
	if (match[1] === "templates")
		return {
			action: "templates",
			...(match[2] === undefined ? {} : { path: match[2] }),
		};
	if (match[1] === "run" || match[1] === "load") {
		const path = match[2];
		if (path === undefined) throw new Error("Give a template name or path");
		return {
			action: match[1],
			path: /^[a-z][a-z0-9-]{0,63}$/.test(path) ? `.amazme/workflows/${path}.json` : path,
			...(match[3] === undefined ? {} : { args: match[3] }),
		};
	}
	return {
		action: match[1]!,
		...(match[2] === undefined ? {} : { runId: match[2] }),
	};
}

export default defineFacet({
	id: "@amazme/workflows/session",
	setup(env) {
		const extensions = env.use(AgentExtensions),
			runtime = env.use(AgentRuntime),
			commands = env.use(SlashCommands);
		env.onActivate(() => {
			env.own(extensions.install(workflowExtension(runtime)));
			env.own(
				commands.replace({
					name: "workflows",
					description: "Run, inspect, pause, resume or stop optional workflows",
					argumentHint: "<list|templates|run|load|status|pause|resume|stop> [path|runId] [args]",
					getArgumentCompletions: (prefix) =>
						["list", "templates", "run", "load", "status", "pause", "resume", "stop"]
							.filter((action) => action.startsWith(prefix))
							.map((value) => ({ value, label: value })),
					async run(args, context) {
						const input = commandArgs(args);
						if (input === null || typeof input !== "object" || Array.isArray(input))
							throw new Error("Workflow command arguments must be an object");
						const { harness, conversation } = await runtime.current(context),
							callId = `workflow-command:${randomUUID()}`;
						const { action, ...remaining } = input;
						const toolName = action === "save" ? "workflow_save" : "workflow",
							arguments_ = action === "save" ? remaining : input;
						const id = await harness.commit(
							(tx) =>
								tx.createTask(
									ToolTask,
									{
										nested: {
											parentCallId: callId,
											depth: 1,
											call: {
												type: "toolCall",
												id: callId,
												name: toolName,
												arguments: arguments_,
											},
										},
									},
									{
										conversationId: conversation.id,
										ownership: { kind: "conversation" },
									},
								),
							context,
						);
						try {
							await harness.waitForTask(id, context);
						} catch (error) {
							if (context.abortSignal?.aborted) {
								const cleanup = withoutAbortSignal(context);
								await harness.abortTask(id, cleanup);
								await harness.waitForTask(id, cleanup);
							}
							throw error;
						}
					},
				}),
			);
		});
	},
});
