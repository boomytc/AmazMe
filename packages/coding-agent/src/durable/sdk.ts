import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { AssistantMessage, ImageContent, Message, ModelThinkingLevel } from "@amazme/ai";
import type { AgentEvent, AgentEventStream, ModelRef } from "@amazme/durable";
import { agentOf, openDurable, type OpenDurableOptions } from "./runtime.ts";

const context = BACKGROUND_CONTEXT;

export interface DurableSessionOptions extends OpenDurableOptions {
	readonly initialMessage?: string;
	readonly initialImages?: readonly ImageContent[];
}

export interface DurablePromptOptions {
	readonly images?: readonly ImageContent[];
}

/**
 * Experimental in-process SDK over one Durable session.
 *
 * This is the first SDK-shaped facade of the single-kernel migration. It is deliberately not
 * `createAgentSession`: that API owns the JSONL transcript, extension UI and session manager.
 * A caller that only needs prompt, steer, follow-up, abort, compaction, model selection and the
 * Durable event stream can use this instead, and receives the committed answer rather than a
 * view snapshot.
 */
export interface DurableSession {
	readonly id: string;
	readonly conversationId: string;
	readonly model: ModelRef | undefined;
	readonly thinkingLevel: ModelThinkingLevel | undefined;
	prompt(text: string, options?: DurablePromptOptions): Promise<AssistantMessage | undefined>;
	/** Steer the active run, or start one when idle. Resolves with that input's answer. */
	steer(text: string, options?: DurablePromptOptions): Promise<AssistantMessage | undefined>;
	/** Queue input for the next run, or start one when idle. Resolves with that input's answer. */
	followUp(text: string, options?: DurablePromptOptions): Promise<AssistantMessage | undefined>;
	abort(): Promise<void>;
	/** Start a manual compaction. It runs as its own Durable task and its events arrive on the stream. */
	compact(instructions?: string): Promise<void>;
	setModel(model: ModelRef): Promise<void>;
	setThinkingLevel(level: ModelThinkingLevel): Promise<void>;
	/** The model messages of the current active context. */
	messages(): readonly Message[];
	/** Batches of the experimental Durable agent events, one batch per commit. */
	subscribe(listener: (events: readonly AgentEvent[]) => void): () => void;
	dispose(): Promise<void>;
}

export async function createDurableSession(options: DurableSessionOptions = {}): Promise<DurableSession> {
	const durable = await openDurable(options);
	const listeners = new Set<(events: readonly AgentEvent[]) => void>();
	let stream: AgentEventStream | undefined;
	let closing: Promise<void> | undefined;

	const dispose = (): Promise<void> => {
		closing ??= (async () => {
			try {
				await stream?.stop();
			} finally {
				await durable.close();
			}
		})();
		return closing;
	};

	try {
		stream = await durable.watchAgentEvents();
		stream.start(async (events) => {
			for (const listener of [...listeners]) {
				try {
					listener(events);
				} catch (error) {
					console.error(error instanceof Error ? error.message : String(error));
				}
			}
		});
	} catch (error) {
		await dispose();
		throw error;
	}

	const run = async (
		text: string,
		whenBusy: "steer" | "followUp",
		options?: DurablePromptOptions,
	): Promise<AssistantMessage | undefined> => {
		const result = await durable.controller.submitAndWait(text, whenBusy, options?.images);
		if (!result.accepted) throw new Error("Durable session did not accept the input");
		if (result.settled?.status === "unanswered") {
			const detail = result.settled.detail === undefined ? "" : ` ${JSON.stringify(result.settled.detail)}`;
			throw new Error(`No answer: ${result.settled.reason}${detail}`);
		}
		return result.answer;
	};

	const view = (): ReturnType<typeof durable.view.current> => durable.view.current();

	const session: DurableSession = {
		get id() {
			return view().session.id;
		},
		get conversationId() {
			return String(view().conversation.conversation.id);
		},
		get model() {
			return agentOf(view().conversation).model;
		},
		get thinkingLevel() {
			return agentOf(view().conversation).thinkingLevel;
		},
		prompt: (text, promptOptions) => run(text, "steer", promptOptions),
		steer: (text, promptOptions) => run(text, "steer", promptOptions),
		followUp: (text, promptOptions) => run(text, "followUp", promptOptions),
		abort: () => durable.controller.abort(),
		compact: (instructions) => durable.controller.compactNow(instructions),
		setModel: (model) => durable.controller.setModelNow(model),
		setThinkingLevel: (level) => durable.controller.setThinkingLevelNow(level),
		messages: () => view().conversation.entries.flatMap((entry) => entry.model ?? []),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose,
	};
	if (options.initialMessage !== undefined || (options.initialImages?.length ?? 0) > 0) {
		await run(options.initialMessage ?? "", "steer", { images: options.initialImages });
	}
	return session;
}
