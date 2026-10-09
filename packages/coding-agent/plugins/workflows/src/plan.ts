import { Type, validateToolArguments } from "@amazme/ai";
import type { JsonObject, Static } from "@amazme/ai";

const label = Type.String({ minLength: 1, maxLength: 120 });
const text = Type.String({ minLength: 1, maxLength: 16000 });
const tool = Type.String({ minLength: 1, maxLength: 120 });

export const PlanSchema = Type.Object(
	{
		version: Type.Literal(1),
		name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
		description: text,
		concurrency: Type.Integer({ minimum: 1, maximum: 8 }),
		maxJobs: Type.Integer({ minimum: 1, maximum: 128 }),
		jobTimeoutSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
		stages: Type.Array(
			Type.Object(
				{
					name: label,
					role: Type.Union([Type.Literal("work"), Type.Literal("verify"), Type.Literal("synthesize")]),
					onFailure: Type.Union([Type.Literal("stop"), Type.Literal("continue")]),
					jobs: Type.Array(
						Type.Union([
							Type.Object(
								{
									kind: Type.Literal("agent"),
									name: label,
									prompt: text,
									tools: Type.Array(tool, { maxItems: 32, uniqueItems: true }),
								},
								{ additionalProperties: false },
							),
							Type.Object(
								{
									kind: Type.Literal("command"),
									name: label,
									tool: Type.Union([Type.Literal("bash"), Type.Literal("powershell")]),
									command: Type.String({ minLength: 1, maxLength: 8192 }),
								},
								{ additionalProperties: false },
							),
						]),
						{ minItems: 1, maxItems: 32 },
					),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 16 },
		),
	},
	{ additionalProperties: false },
);

export type Plan = Static<typeof PlanSchema>;
export type JobSpec = Plan["stages"][number]["jobs"][number];

/** One data format and the same argument validator as model calls; no executable plan language. */
export function readPlan(value: unknown): Plan {
	const checked: unknown = validateToolArguments(
		{
			name: "workflow_plan",
			description: "Workflow plan",
			parameters: PlanSchema,
		},
		{
			type: "toolCall",
			id: "plan",
			name: "workflow_plan",
			arguments: value as JsonObject,
		},
	);
	const plan = checked as Plan;
	if (plan.stages.reduce((total, stage) => total + stage.jobs.length, 0) > plan.maxJobs)
		throw new Error("Workflow exceeds maxJobs");
	if (new Set(plan.stages.map((stage) => stage.name)).size !== plan.stages.length)
		throw new Error("Stage names must be unique");
	for (const stage of plan.stages) {
		if (new Set(stage.jobs.map((job) => job.name)).size !== stage.jobs.length)
			throw new Error(`Job names must be unique in ${stage.name}`);
		if (
			stage.jobs.some(
				(job) => job.kind === "agent" && job.tools.some((name) => name === "subagent" || name === "workflow"),
			)
		)
			throw new Error("Workflow jobs cannot delegate further");
	}
	return plan;
}
