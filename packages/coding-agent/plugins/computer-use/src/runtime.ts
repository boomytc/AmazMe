import type { ClassifierResult } from "@amazme/ai";
import type { Context, JsonValue } from "@amazme/chord";
import type { Harness, ToolExecutionApi } from "@amazme/durable";
import type { ComputerUseSettings } from "./config.ts";
import {
	ComputerUsePolicy,
	DEFAULT_COMPUTER_USE_SETTINGS,
	probability,
	readComputerUseSettings,
} from "./config.ts";
import type { Snapshot, WindowTarget } from "./driver.ts";
import { DriverClient } from "./driver.ts";
import type { Classify, LocateResult } from "./jev.ts";
import {
	chooseCandidateWithJev,
	imageContext,
	locateWithJevCrop,
	locateWithJevTiles,
	noul,
	riskQuestions,
	risksAccepted,
} from "./jev.ts";
import {
	blockedRisks,
	extractCandidates,
	FALLBACK_CANDIDATES,
	visualFallbackReason,
} from "./native-candidates.ts";

export type Action = {
	action:
		| "click"
		| "double_click"
		| "right_click"
		| "set_value"
		| "type_text"
		| "press_key"
		| "hotkey"
		| "scroll"
		| "drag";
	element_token?: string;
	x?: number;
	y?: number;
	to_x?: number;
	to_y?: number;
	value?: string;
	text?: string;
	key?: string;
	keys?: string[];
	direction?: "up" | "down" | "left" | "right";
	amount?: number;
	delivery_mode?: "background" | "foreground";
};

export function snapshotReport(
	snapshot: Snapshot,
	policy: ComputerUseSettings,
) {
	return {
		pid: snapshot.pid ?? null,
		window_id: snapshot.windowId ?? null,
		capture_id: snapshot.captureId,
		snapshot_id: snapshot.snapshotId ?? null,
		width: snapshot.width,
		height: snapshot.height,
		tree: snapshot.treeMarkdown.slice(0, 20_000),
		tree_truncated: snapshot.treeMarkdown.length > 20_000,
		degraded_reason: snapshot.degradedReason ?? null,
		candidates: extractCandidates(snapshot, policy).map(
			({ elementToken, ...candidate }) => ({
				...candidate,
				element_token: elementToken,
			}),
		),
		fallbacks: FALLBACK_CANDIDATES,
	};
}

export function classifier(
	api: ToolExecutionApi,
	policy: ComputerUseSettings,
): Classify {
	if (!policy.jevEnabled)
		throw new Error("Jev is disabled; enable it with /computer-use settings");
	const model = api.models.getModelOfType(
		"classifier",
		policy.jevProvider,
		policy.jevModel,
	);
	if (!model)
		throw new Error(
			`Classifier ${policy.jevProvider}/${policy.jevModel} is unavailable`,
		);
	return (input, signal) => api.models.classify(model, input, { signal });
}

/** Covers commands, direct calls and nested code-mode calls with the same process-local mutation line. */
export class ComputerUseController {
	private readonly drivers = new Map<string, DriverClient>();
	private readonly controller = new AbortController();
	private tail: Promise<unknown> = Promise.resolve();
	private closing?: Promise<void>;
	private readonly subscriptions = new Map<Harness, () => void>();
	private readonly driverFactory: (conversationId: string) => DriverClient;

	constructor(
		driverFactory: (conversationId: string) => DriverClient = (id) =>
			new DriverClient(id),
	) {
		this.driverFactory = driverFactory;
	}
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	bind(harness: Harness): void {
		this.controller.signal.throwIfAborted();
		if (!this.subscriptions.has(harness))
			this.subscriptions.set(
				harness,
				harness.subscribeClose(() => {
					void this.dispose().catch(() => {});
				}),
			);
	}

	serial<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const run = this.tail.then(async () => {
			this.controller.signal.throwIfAborted();
			signal?.throwIfAborted();
			return work();
		});
		this.tail = run.catch(() => {});
		return run;
	}

	async run<T>(
		api: ToolExecutionApi,
		context: Context,
		work: (
			driver: DriverClient,
			policy: ComputerUseSettings,
			signal: AbortSignal,
		) => Promise<T>,
	): Promise<T> {
		return this.serial(async () => {
			const policy = readComputerUseSettings(
				(await api.snapshot(ComputerUsePolicy, api.conversationId, context)) ??
					DEFAULT_COMPUTER_USE_SETTINGS,
			);
			if (!policy.enabled)
				throw new Error(
					"Computer use is disabled; the user must run /computer-use on",
				);
			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(new Error("Computer-use operation timed out")),
				policy.timeoutMs,
			);
			const signals = [
				this.controller.signal,
				controller.signal,
				...(context.abortSignal ? [context.abortSignal] : []),
			];
			const signal = AbortSignal.any(signals);
			const id = String(api.conversationId);
			let driver = this.drivers.get(id);
			if (!driver) {
				driver = this.driverFactory(id);
				this.drivers.set(id, driver);
			}
			try {
				return await work(driver, policy, signal);
			} catch (error) {
				// An interrupted native action has an unknown outcome. Retire its session, including all old references.
				this.drivers.delete(id);
				await driver.dispose();
				throw error;
			} finally {
				clearTimeout(timer);
			}
		}, context.abortSignal);
	}

	async disable(conversationId: string): Promise<void> {
		const driver = this.drivers.get(conversationId);
		if (driver) {
			this.drivers.delete(conversationId);
			await driver.dispose();
		}
	}

	dispose(): Promise<void> {
		if (this.closing) return this.closing;
		this.controller.abort(new Error("Computer-use plugin closed"));
		this.closing = (async () => {
			await this.tail;
			const results = await Promise.allSettled(
				[...this.drivers.values()].map((driver) => driver.dispose()),
			);
			this.drivers.clear();
			for (const unsubscribe of this.subscriptions.values()) unsubscribe();
			this.subscriptions.clear();
			const failure = results.find((result) => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		})();
		return this.closing;
	}
}

export async function locate(
	snapshot: Snapshot,
	target: string,
	mode: "look_closer" | "tiled",
	classify: Classify,
	policy: ComputerUseSettings,
	signal: AbortSignal,
): Promise<LocateResult> {
	if (mode === "tiled")
		return locateWithJevTiles(
			snapshot.imageBytes,
			target,
			classify,
			policy,
			signal,
		);
	const result = await locateWithJevCrop(
		snapshot.imageBytes,
		target,
		classify,
		policy,
		signal,
	);
	if (result.status !== "review") return result;
	const fallback = await locateWithJevTiles(
		snapshot.imageBytes,
		target,
		classify,
		policy,
		signal,
	);
	return { ...fallback, calls: [...result.calls, ...fallback.calls] };
}

function point(
	x: number | undefined,
	y: number | undefined,
	snapshot: Snapshot,
): { x: number; y: number } {
	if (
		x === undefined ||
		y === undefined ||
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		x < 0 ||
		y < 0 ||
		x >= snapshot.width ||
		y >= snapshot.height
	)
		throw new Error("Action point is outside the current capture");
	return { x, y };
}

function planAction(
	action: Action,
	driver: DriverClient,
	snapshot: Snapshot,
	policy: ComputerUseSettings,
	target?: WindowTarget,
) {
	const mode = action.delivery_mode ?? "background";
	if (mode === "foreground" && !policy.allowForeground)
		throw new Error("Foreground delivery is disabled by user policy");
	if (!target && mode !== "foreground")
		throw new Error(
			"Desktop actions require explicitly permitted foreground delivery",
		);
	const tool = ["click", "double_click", "right_click"].includes(action.action)
		? "click"
		: action.action;
	if (!driver.supports(tool))
		throw new Error(`Driver does not support ${tool}`);
	const args: Record<string, unknown> = {};
	if (driver.supports(tool, "target"))
		args.target = target
			? { kind: "window", ...target }
			: { kind: "desktop", display_id: "primary" };
	else if (
		target &&
		driver.supports(tool, "pid") &&
		driver.supports(tool, "window_id")
	)
		Object.assign(args, target);
	else throw new Error(`Driver ${tool} cannot address the exact target`);
	if (driver.supports(tool, "delivery_mode")) args.delivery_mode = mode;
	else if (tool !== "set_value" || mode !== "background")
		throw new Error(
			`Driver ${tool} cannot guarantee the requested delivery mode`,
		);
	let candidateId: string | undefined;
	if (action.element_token) {
		const candidate = extractCandidates(snapshot, policy).find(
			(entry) => entry.elementToken === action.element_token,
		);
		if (
			!target ||
			!snapshot.snapshotId ||
			!candidate ||
			!action.element_token.startsWith(`${snapshot.snapshotId}:`)
		)
			throw new Error(
				"Element token is stale, excluded or not in this window's candidate table",
			);
		if (!driver.supports(tool, "element_token"))
			throw new Error(`Driver ${tool} does not accept element_token`);
		if (
			["set_value", "type_text"].includes(tool) &&
			candidate.role !== "text_input" &&
			!(tool === "set_value" && candidate.role === "popup")
		)
			throw new Error(
				"Text actions require a text input or an explicitly valued popup",
			);
		args.element_token = action.element_token;
		candidateId = candidate.id;
	}
	if (tool === "click" && !action.element_token) {
		Object.assign(args, point(action.x, action.y, snapshot));
		if (!driver.supports(tool, "capture_id"))
			throw new Error("Driver cannot dispatch capture-bound clicks");
		args.capture_id = snapshot.captureId;
	}
	if (action.action === "double_click") args.count = 2;
	if (action.action === "right_click") args.button = "right";
	if (tool === "set_value" || tool === "type_text") {
		if (!action.element_token)
			throw new Error("Text actions require a fresh element_token");
		const value = tool === "set_value" ? action.value : action.text;
		if (value === undefined) throw new Error(`${tool} requires text`);
		args[tool === "set_value" ? "value" : "text"] = value;
	}
	if (tool === "press_key") {
		if (!action.key) throw new Error("press_key requires key");
		args.key = action.key;
	}
	if (tool === "hotkey") {
		if (!action.keys || action.keys.length < 2)
			throw new Error("hotkey requires at least two keys");
		args.keys = action.keys;
	}
	if (tool === "drag" || tool === "scroll") {
		if (tool === "scroll") {
			if (!action.direction) throw new Error("scroll requires direction");
			Object.assign(args, {
				direction: action.direction,
				amount: action.amount ?? 3,
			});
			if (
				!action.element_token ||
				action.x !== undefined ||
				action.y !== undefined
			)
				Object.assign(args, point(action.x, action.y, snapshot));
		} else {
			const p = point(action.x, action.y, snapshot);
			const to = point(action.to_x, action.to_y, snapshot);
			// Driver converts screenshot pixels into screen coordinates, including Retina scale.
			Object.assign(args, {
				from_x: p.x,
				from_y: p.y,
				to_x: to.x,
				to_y: to.y,
			});
		}
	}
	for (const key of Object.keys(args))
		if (!driver.supports(tool, key))
			throw new Error(`Driver ${tool} cannot accept ${key}`);
	return { tool, args, candidateId };
}

export async function act(
	driver: DriverClient,
	captureId: string,
	snapshotId: string | undefined,
	target: WindowTarget | undefined,
	intent: string,
	actions: readonly Action[],
	classify: Classify | undefined,
	policy: ComputerUseSettings,
	signal: AbortSignal,
) {
	const initial = driver.current(captureId, target);
	if (snapshotId !== undefined && initial.snapshotId !== snapshotId)
		throw new Error("Stale snapshot_id");
	if (!actions.length || actions.length > 16)
		throw new Error("Provide 1 to 16 actions");
	if (blockedRisks(intent, policy).length)
		return {
			status: "review",
			reason: "Intent contains a risk category not allowed by user policy",
			applied: 0,
		};
	if (
		actions.length > 1 &&
		actions.some(
			(action) =>
				!action.element_token &&
				["click", "double_click", "right_click", "drag", "scroll"].includes(
					action.action,
				),
		)
	)
		throw new Error(
			"Coordinate actions require individual observations; use a single action",
		);
	const plans = actions.map((action) => ({
		action,
		...planAction(action, driver, initial, policy, target),
	}));
	const calls: ClassifierResult[] = [];
	let applied = 0;
	try {
		for (const [index, planned] of plans.entries()) {
			let current = driver.current(driver.snapshot?.captureId ?? "", target);
			let action = planned.action;
			const stableId = planned.candidateId;
			if (index && stableId) {
				const replacement = extractCandidates(current, policy).find(
					(entry) => entry.id === stableId,
				);
				if (!replacement)
					throw new Error(
						"Batch target disappeared; remaining actions were not sent",
					);
				action = { ...action, element_token: replacement.elementToken };
			}
			const plan = planAction(action, driver, current, policy, target);
			// Labels are a deterministic filter. Unbound pixels and keys also require a semantic risk check.
			if (classify && Object.keys(riskQuestions(policy)).length) {
				const observation = imageContext(current.imageBytes, 640);
				const candidate = extractCandidates(current, policy).find(
					(entry) => entry.id === stableId,
				);
				const risk = await classify(
					{
						state: {
							target: intent,
							action: {
								tool: plan.tool,
								parameters: plan.args as JsonValue,
								...(candidate
									? {
											candidate: {
												role: candidate.role,
												label: candidate.label,
											},
										}
									: {}),
							},
							observation: observation.state,
						},
						assets: observation.assets,
						questions: riskQuestions(policy),
					},
					signal,
				);
				calls.push(risk);
				if (!risksAccepted(risk, policy))
					return {
						status: "review",
						reason: "Action risk is not confidently within user policy",
						applied,
						calls,
					};
			} else if (
				!classify &&
				(!action.element_token ||
					![
						"click",
						"double_click",
						"right_click",
						"set_value",
						"type_text",
					].includes(action.action))
			) {
				return {
					status: "review",
					reason: "Jev is required to assess coordinate and keyboard actions",
					applied,
					calls,
				};
			}
			current = driver.current(current.captureId, target);
			signal.throwIfAborted();
			driver.snapshot = undefined;
			await driver.call(plan.tool, plan.args, policy.timeoutMs, signal);
			applied++;
			if (index < actions.length - 1)
				await driver.observe(target, policy.timeoutMs, signal);
		}
		return { status: "acted", applied, calls };
	} catch (error) {
		driver.snapshot = undefined;
		signal.throwIfAborted();
		return {
			status: "review",
			reason: error instanceof Error ? error.message : String(error),
			applied,
			outcome_unknown: true,
			calls,
		};
	}
}

export async function groundAndAct(
	driver: DriverClient,
	target: WindowTarget,
	goal: string,
	verification: string,
	action: "click" | "set_value" | "type_text",
	text: string | undefined,
	classify: Classify,
	policy: ComputerUseSettings,
	signal: AbortSignal,
) {
	if (blockedRisks(goal, policy).length)
		return {
			status: "review",
			reason: "Goal contains a blocked risk category",
		};
	const before = await driver.observe(target, policy.timeoutMs, signal);
	const candidates = extractCandidates(before, policy);
	let next: Action | undefined,
		calls: ClassifierResult[] = [];
	if (!visualFallbackReason(before, candidates)) {
		const choice = await chooseCandidateWithJev(
			goal,
			JSON.stringify(snapshotReport(before, policy)),
			candidates,
			classify,
			policy,
			signal,
		);
		calls.push(choice.call);
		if (choice.goalSatisfied)
			return { status: "already_satisfied", acted: false, calls };
		if (choice.choice === "reobserve")
			return {
				status: "review",
				reason: "Jev requested reobservation",
				acted: false,
				calls,
			};
		const selected = candidates.find(({ id }) => id === choice.choice);
		if (selected)
			next = {
				action,
				element_token: selected.elementToken,
				...(action === "set_value" ? { value: text } : { text }),
			};
		else if (!choice.canLocateVisually)
			return {
				status: "review",
				reason: "No confident safe AX selection",
				acted: false,
				calls,
			};
	}
	if (!next) {
		if (action !== "click")
			return {
				status: "review",
				reason: "Text action requires a matching AX field",
				calls,
			};
		const found = await locate(
			before,
			goal,
			"look_closer",
			classify,
			policy,
			signal,
		);
		calls.push(...found.calls);
		if (found.status !== "located")
			return { status: "review", reason: found.reason, acted: false, calls };
		next = { action: "click", x: found.x, y: found.y };
	}
	const result = await act(
		driver,
		before.captureId,
		before.snapshotId,
		target,
		goal,
		[next],
		classify,
		policy,
		signal,
	);
	calls.push(...(result.calls ?? []));
	if (result.status !== "acted") return { ...result, calls };
	try {
		const after = await driver.observe(target, policy.timeoutMs, signal);
		const observation = imageContext(after.imageBytes);
		const checked = await classify(
			{
				state: {
					goal,
					verification,
					observation: {
						...observation.state,
						tree: after.treeMarkdown.slice(0, 20_000),
					},
				},
				assets: observation.assets,
				questions: {
					verified: noul(
						"Does the new observation independently prove verification is satisfied? Evaluate the visible resulting state, not whether an action was attempted.",
					),
				},
			},
			signal,
		);
		signal.throwIfAborted();
		calls.push(checked);
		const answer = checked.answers.verified;
		const verified =
			checked.stopReason === "stop" &&
			answer?.type === "bool" &&
			probability(answer.probability) &&
			answer.probability >= policy.minPresence;
		return {
			status: verified ? "verified" : "review",
			acted: true,
			verified,
			verification_probability:
				answer?.type === "bool" ? answer.probability : null,
			capture_id: after.captureId,
			snapshot_id: after.snapshotId ?? null,
			calls,
		};
	} catch (error) {
		driver.snapshot = undefined;
		signal.throwIfAborted();
		return {
			status: "review",
			acted: true,
			verified: false,
			reason: `Action was dispatched but verification failed: ${error instanceof Error ? error.message : String(error)}`,
			calls,
		};
	}
}
