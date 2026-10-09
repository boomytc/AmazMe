import { randomUUID } from "node:crypto";
import { Type } from "@amazme/ai";
import { defineFacet } from "@amazme/chord";
import type { JsonValue } from "@amazme/chord";
import { AgentController, AgentExtensions, SlashCommands } from "@amazme/coding-agent/plugin";
import { defineExtension, defineTool } from "@amazme/durable";
import type { TaskId, ToolExecutionApi, Tx } from "@amazme/durable";
import { boundImages, lockImages, readImage, sameRevision, scope } from "./files.ts";
import type { Image } from "./files.ts";
import { Restore } from "./restore.ts";
import type { Result } from "./restore.ts";
import { Index, Preview, preview, RestoreOwner, Snapshots, summary } from "./state.ts";
import type { Snapshot } from "./state.ts";

const MAX_CHECKPOINTS = 20;
const paths = Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 16 });
const uuid = Type.String({ pattern: "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$" });

async function available(api: ToolExecutionApi, context: Parameters<ToolExecutionApi["commit"]>[1]) {
	const owner = await api.snapshot(RestoreOwner, context);
	if (owner?.task !== undefined && owner.task !== null) {
		const task = await api.getTask(owner.task, context);
		if (task !== undefined && task.state.status !== "terminal")
			throw new Error(`Checkpoint restore ${owner.task} is still active`);
	}
}

async function availableIn(tx: Tx) {
	const owner = await tx.doc(RestoreOwner);
	if (owner.task !== null) {
		const task = await tx.task(owner.task);
		if (task !== undefined && task.state.status !== "terminal")
			throw new Error(`Checkpoint restore ${owner.task} is still active`);
	}
	return owner;
}

const checkpoint = defineTool({
	name: "file_checkpoint",
	description:
		"Manage optional file checkpoints in this conversation. create snapshots explicitly selected project files, including absent paths. preview returns file changes and a plan ID without changing files. Only restore after the user has selected files and approved the preview; restore requires that plan ID and explicit paths. A pre-restore checkpoint is saved first; failures and cancellation roll back checked publications. External edits are preserved as conflicts. list/status/remove manage stored records. Conversation history is not rewound.",
	parameters: Type.Object({
		action: Type.Union(
			["create", "list", "preview", "restore", "status", "remove"].map((value) => Type.Literal(value)),
		),
		name: Type.Optional(Type.String({ maxLength: 80 })),
		paths: Type.Optional(paths),
		id: Type.Optional(uuid),
		plan: Type.Optional(uuid),
	}),
	replay: "safe",
	executionMode: "sequential",
	async execute(args, api, context) {
		const env = api.env;
		if (env === undefined) throw new Error("File checkpoints require a file environment");
		const index = await api.snapshot(Index, api.conversationId, context);
		let value: JsonValue;
		if (args.action === "list")
			value = { checkpoints: index?.snapshots ?? [], lastRestore: index?.lastRestore ?? null };
		else if (args.action === "status") {
			const id = index?.lastRestore;
			const record = id == null ? undefined : await api.getTask(id as TaskId<Result>, context);
			const outcome = record?.state.status === "terminal" ? record.state.outcome : undefined;
			const input = record?.input;
			const backup =
				input !== null && typeof input === "object" && !Array.isArray(input) && typeof input.backup === "string"
					? input.backup
					: null;
			value =
				record === undefined
					? { task: null }
					: {
							task: record.id,
							status: record.state.status,
							outcome: outcome?.status ?? null,
							error: outcome?.error?.message ?? null,
							reason: outcome?.reason ?? null,
							backup,
							result: outcome?.result ?? null,
						};
		} else if (args.action === "create") {
			await available(api, context);
			if (args.paths === undefined) throw new Error("Creating a checkpoint requires explicit paths");
			const id = await api.memo("checkpoint.create", randomUUID(), context);
			const existing = index?.snapshots.find((entry) => entry.id === id);
			if (existing !== undefined) value = existing;
			else {
				const files: Image[] = [];
				for (const path of args.paths) files.push(await readImage(env, path, context));
				boundImages(files);
				const snapshot: Snapshot = {
					...(await scope(env, context)),
					name: args.name ?? "Checkpoint",
					createdAt: Date.now(),
					files,
				};
				value = await lockImages(
					env,
					files,
					async () => {
						for (const observed of files)
							if (!sameRevision(await readImage(env, observed.path, context), observed))
								throw new Error(`File changed before checkpoint publication: ${observed.path}`);
						return api.commit(async (tx) => {
							await availableIn(tx);
							const current = await tx.doc(Index, api.conversationId);
							if (current.snapshots.length >= MAX_CHECKPOINTS)
								throw new Error("Remove an old checkpoint before saving another");
							await tx.doc(Snapshots, api.conversationId, id, snapshot);
							const entry = summary(id, snapshot);
							current.snapshots = [...current.snapshots, entry];
							return entry;
						}, context);
					},
					context,
				);
			}
		} else if (args.action === "restore") {
			if (args.plan === undefined || args.paths === undefined)
				throw new Error("Restore requires a preview plan ID and explicit selected paths");
			const selected = await api.snapshot(Preview, api.conversationId, context);
			if (selected?.plan?.id !== args.plan)
				throw new Error("Restore plan is unavailable; preview the checkpoint again");
			const plan = {
				...selected.plan,
				files: selected.plan.files.filter(({ before }) => args.paths!.includes(before.path)),
			};
			if (plan.files.length !== args.paths.length || new Set(args.paths).size !== args.paths.length)
				throw new Error("Every selected path must occur exactly once in the preview");
			let id: TaskId;
			if (selected.accepted !== null) {
				if (selected.accepted.caller !== api.taskId)
					throw new Error("Restore plan has already been accepted; preview again");
				id = selected.accepted.task;
			} else {
				await available(api, context);
				const currentScope = await scope(env, context);
				if (currentScope.root !== plan.root || currentScope.envId !== plan.envId)
					throw new Error("Restore plan belongs to another project or environment");
				for (const { before } of plan.files)
					if (!sameRevision(await readImage(env, before.path, context), before))
						throw new Error(`File changed since the restore preview: ${before.path}`);
				id = await api.commit(async (tx) => {
					const owner = await availableIn(tx);
					const pending = await tx.doc(Preview, api.conversationId);
					if (pending.plan?.id !== plan.id || pending.accepted !== null)
						throw new Error("Restore preview changed before admission");
					const current = await tx.doc(Index, api.conversationId);
					if (current.snapshots.length >= MAX_CHECKPOINTS)
						throw new Error("Remove an old checkpoint to make room for the restore backup");
					const backup = randomUUID();
					const snapshot: Snapshot = {
						root: plan.root,
						envId: plan.envId,
						name: `Before restore ${plan.snapshot}`,
						createdAt: Date.now(),
						files: plan.files.map(({ before }) => before),
					};
					await tx.doc(Snapshots, api.conversationId, backup, snapshot);
					current.snapshots = [...current.snapshots, summary(backup, snapshot)];
					const task = await tx.createTask(
						Restore,
						{ plan, backup },
						{ ownership: { kind: "task", taskId: api.taskId } },
					);
					owner.task = task;
					current.lastRestore = task;
					pending.accepted = { caller: api.taskId, task };
					return task;
				}, context);
			}
			const settled = await api.waitForTask(id as TaskId<Result>, context);
			const result = settled.state.outcome.result;
			value = { task: id, outcome: settled.state.outcome.status, result: result ?? null };
			return {
				content: [{ type: "text", text: JSON.stringify(value) }],
				structuredContent: value,
				isError: result?.status !== "restored",
			};
		} else {
			await available(api, context);
			if (args.id === undefined || !index?.snapshots.some((entry) => entry.id === args.id))
				throw new Error("Checkpoint is not available in this conversation branch");
			if (args.action === "remove")
				value = await api.commit(async (tx) => {
					await availableIn(tx);
					const current = await tx.doc(Index, api.conversationId);
					current.snapshots = current.snapshots.filter((entry) => entry.id !== args.id);
					await tx.retireDoc(Snapshots, api.conversationId, args.id!);
					const pending = await tx.doc(Preview, api.conversationId);
					if (pending.plan?.snapshot === args.id) {
						pending.plan = null;
						pending.accepted = null;
					}
					return { removed: args.id! };
				}, context);
			else {
				const snapshot = await api.snapshot(Snapshots, api.conversationId, args.id, context);
				if (snapshot === undefined) throw new Error("Checkpoint data is unavailable");
				const currentScope = await scope(env, context);
				if (snapshot.root !== currentScope.root || snapshot.envId !== currentScope.envId)
					throw new Error("Checkpoint belongs to another project or environment");
				const selected =
					args.paths === undefined ? snapshot.files : snapshot.files.filter((file) => args.paths!.includes(file.path));
				if (selected.length === 0 || (args.paths !== undefined && selected.length !== args.paths.length))
					throw new Error("Selected paths are not in the checkpoint");
				const files: { before: Image; after: Image }[] = [];
				for (const after of selected) {
					const before = await readImage(env, after.path, context);
					if (before.target !== after.target) throw new Error(`Checkpoint target changed: ${after.path}`);
					files.push({ before, after });
				}
				boundImages(files.map(({ before }) => before));
				const plan = {
					...currentScope,
					id: await api.memo("checkpoint.preview", randomUUID(), context),
					snapshot: args.id,
					files,
				};
				await api.commit(async (tx) => {
					await availableIn(tx);
					const pending = await tx.doc(Preview, api.conversationId);
					pending.plan = plan;
					pending.accepted = null;
				}, context);
				value = preview(plan);
			}
		}
		return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
	},
});

export default defineFacet({
	id: "@amazme/checkpoint/session",
	setup(env) {
		const extensions = env.use(AgentExtensions),
			commands = env.use(SlashCommands),
			agent = env.use(AgentController);
		env.onActivate(() => {
			env.own(extensions.install(defineExtension({ name: "file-checkpoint", tools: [checkpoint], tasks: [Restore] })));
			env.own(
				commands.replace({
					name: "checkpoint",
					description: "Create or preview selected-file checkpoints",
					argumentHint: "<request>",
					run(request, context) {
						return agent.prompt(
							{
								message: `Use file_checkpoint to ${request.trim() || "list current checkpoints"}. Preview before restoring. Only restore files explicitly selected and approved by the user; report the backup ID and any conflicts.`,
								images: null,
							},
							context,
						);
					},
				}),
			);
		});
	},
});
