import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@amazme/chord";
import type { ToolCall } from "@amazme/ai";
import { defineExtension, hook, ToolTask } from "@amazme/durable";
import type { ToolApprovalMode } from "../../core/settings-manager.ts";
import { Approvals, type ApprovalRequest, type ApprovalsState } from "./approvals.ts";

/** The tools that change the machine, which `dangerous` asks about. */
const DANGEROUS_TOOLS: readonly string[] = ["bash", "powershell", "write", "edit"];

/** Whether one tool call waits for a decision under a policy. */
export function toolNeedsApproval(mode: ToolApprovalMode, tool: string): boolean {
	if (mode === "off") return false;
	if (mode === "all") return true;
	return DANGEROUS_TOOLS.includes(tool);
}

/** The line a reader judges a call by: the tool's own arguments, kept short. */
export function describeCall(call: ToolCall): string {
	let rendered: string;
	try {
		rendered = JSON.stringify(call.arguments ?? {});
	} catch {
		rendered = String(call.arguments);
	}
	return rendered.length > 400 ? `${rendered.slice(0, 400)}…` : rendered;
}

/**
 * The tool boundary's pause: a `beforeTool` hook that publishes the call as a pending request and
 * waits for the reader's decision. Approving lets the call run; denying settles it as a blocked tool
 * result, which is what the run continues from — there is no second, tool-specific policy engine.
 *
 * The gate is created before the Harness opens (the hook belongs to the registry), so its state is
 * attached by the facet that provides the service.
 */
export function createApprovalGate(options: {
	/** Read at every call, so a settings change applies to the next tool. */
	readonly mode: () => ToolApprovalMode;
	/** The clock, for the request's timestamp. */
	readonly now?: () => number;
}) {
	let state: MutableReplicatedState<ApprovalsState> | undefined;
	const pending = new Map<string, (approved: boolean) => void>();
	let sequence = 0;
	let created: Approvals | undefined;

	const publish = (context: Context, update: (draft: ApprovalsState) => void): void => {
		if (state === undefined) return;
		state.change(context, (draft) => {
			draft.revision += 1;
			update(draft);
		});
	};

	/** Remove one request from the published list and release its waiter. */
	const settle = (id: string, approved: boolean, context: Context): void => {
		const resolve = pending.get(id);
		if (resolve === undefined) return;
		pending.delete(id);
		publish(context, (draft) => {
			draft.pending = draft.pending.filter((request) => request.id !== id);
		});
		resolve(approved);
	};

	return {
		/** Bind the state a facet owns; the gate publishes every request through it. */
		attach(next: MutableReplicatedState<ApprovalsState>): void {
			state = next;
		},
		/** The extension the worker's registry installs, before the Harness opens. */
		extension: defineExtension({
			name: "web-approval-gate",
			hooks: [
				hook(ToolTask, {
					// The handler's parameters come from the tool task's own hook shape.
					async beforeTool(call, api, context) {
						if (!toolNeedsApproval(options.mode(), call.name)) return undefined;
						const id = `approval-${++sequence}`;
						const request: ApprovalRequest = {
							id,
							tool: call.name,
							detail: describeCall(call),
							callId: call.id,
							taskId: String(api.taskId),
							conversationId: String(api.conversationId),
							at: options.now?.() ?? Date.now(),
						};
						const approved = await new Promise<boolean>((resolve) => {
							pending.set(id, resolve);
							publish(context, (draft) => {
								draft.pending = [...draft.pending, request];
							});
							// A turn that is aborted while a call waits settles the request as denied.
							context.abortSignal?.addEventListener(
								"abort",
								() => {
									if (pending.has(id)) settle(id, false, context);
								},
								{ once: true },
							);
						});
						if (approved) return undefined;
						return { block: `Denied by the reader: ${call.name} was not approved.` };
					},
				}),
			],
		}),
		/**
		 * The one service body this gate provides. Its `state` is a data property, which is what a
		 * remote service member must be, so it is built once the facet has attached the state.
		 */
		service(): Approvals {
			if (state === undefined) throw new Error("The approval gate has no state yet");
			created ??= {
				state,
				async decide(id: string, approved: boolean, context: Context): Promise<boolean> {
					if (!pending.has(id)) return false;
					settle(id, approved, context);
					return true;
				},
			};
			return created;
		},
	};
}

export type ApprovalGate = ReturnType<typeof createApprovalGate>;

/** The approvals service as a facet: it owns the state the gate publishes through. */
export function createApprovalsFacet(gate: ApprovalGate): Facet {
	return defineFacet({
		id: "@pi/approvals",
		setup(env) {
			const state = env.replicatedState<ApprovalsState>({ revision: 0, pending: [] });
			gate.attach(state);
			env.provide(Approvals, gate.service());
		},
	});
}
