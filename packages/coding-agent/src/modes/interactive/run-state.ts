import type { ProgramStatus } from "@amazme/tui";

/**
 * Session-level run state for the footer.
 *
 * The program status reported to the terminal (OSC 7501) already knows whether a run is
 * active or blocked on a dialog; the queue and subagent counts live in the interactive
 * session. This module joins them into one compact line so the footer, the terminal
 * status, and future surfaces describe the same state.
 */

export type RunPhase = "idle" | "working" | "blocked";

export type WaitingFor = NonNullable<ProgramStatus["kind"]>;

export interface RunState {
	readonly phase: RunPhase;
	readonly waitingFor?: WaitingFor;
	readonly queueDepth: number;
	readonly subagents: number;
}

export interface RunStateInput {
	readonly program: Pick<ProgramStatus, "state" | "kind">;
	readonly queueDepth: number;
	readonly subagents: number;
}

const WAITING_LABEL: Record<WaitingFor, string> = {
	permission: "approval",
	question: "your answer",
	auth: "sign-in",
};

function count(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function phaseOf(status: ProgramStatus["state"]): RunPhase {
	if (status === "blocked") return "blocked";
	if (status === "working") return "working";
	// `done`, `error`, `clear`, and `idle` all mean no run is waiting on us.
	return "idle";
}

export function deriveRunState(input: RunStateInput): RunState {
	const phase = phaseOf(input.program.state);
	const waitingFor = phase === "blocked" ? (input.program.kind ?? "permission") : undefined;
	return {
		phase,
		...(waitingFor === undefined ? {} : { waitingFor }),
		queueDepth: count(input.queueDepth),
		subagents: count(input.subagents),
	};
}

/** One compact line, or undefined when there is nothing worth saying. */
export function formatRunState(state: RunState): string | undefined {
	if (state.phase === "blocked") {
		return `waiting for ${WAITING_LABEL[state.waitingFor ?? "permission"]}`;
	}
	const parts: string[] = [];
	if (state.phase === "working") parts.push("working");
	if (state.queueDepth > 0) parts.push(state.queueDepth === 1 ? "1 queued" : `${state.queueDepth} queued`);
	if (state.subagents > 0) {
		parts.push(state.subagents === 1 ? "1 subagent" : `${state.subagents} subagents`);
	}
	return parts.length === 0 ? undefined : parts.join(" · ");
}
