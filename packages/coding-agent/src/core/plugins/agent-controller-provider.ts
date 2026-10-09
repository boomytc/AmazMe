import type { Context } from "@amazme/chord";
import type { ImageContent, TextContent } from "@amazme/ai";
import { ConversationBusy } from "@amazme/durable";
import type { Conversation, ConversationId, Harness, SubmissionId, UserInput } from "@amazme/durable";
import type {
	AgentController as AgentControllerService,
	AgentOperationError,
	AgentPromptRequest,
	AgentPromptResult,
	AgentQueueResponse,
} from "./agent-controller.ts";

class UnknownConversation extends Error {}

export function createAgentController(
	harness: Harness,
	conversation: () => Conversation,
	admission?: () => AgentOperationError | undefined,
): AgentControllerService {
	const target = async (request: AgentPromptRequest, context: Context): Promise<Conversation> => {
		if (request.conversationId === undefined) return conversation();
		const id = parseRecordId<ConversationId>(request.conversationId);
		const handle = id === undefined ? undefined : await harness.conversation(id, context);
		if (handle === undefined) throw new UnknownConversation(`Unknown conversation: ${request.conversationId}`);
		return handle;
	};
	const queue = async (
		whenBusy: "steer" | "followUp",
		request: AgentPromptRequest,
		context: Context,
	): Promise<AgentQueueResponse> => {
		const refusal = admission?.();
		if (refusal !== undefined) return { accepted: false, entryId: null, error: refusal };
		try {
			const submission = await (await target(request, context)).submit(
				{
					type: "input",
					content: toInput(request),
					whenBusy,
					...(request.requestId === undefined ? {} : { requestId: request.requestId }),
				},
				context,
			);
			return { accepted: true, entryId: String(submission.id), error: null };
		} catch (error) {
			return { accepted: false, entryId: null, error: toAgentError(error) };
		}
	};

	return {
		async prompt(request, context) {
			const refusal = admission?.();
			if (refusal !== undefined) return { accepted: false, operationId: null, error: refusal };
			try {
				const submission = await (await target(request, context)).submit(
					{
						type: "input",
						content: toInput(request),
						whenBusy: request.whenBusy ?? "reject",
						...(request.requestId === undefined ? {} : { requestId: request.requestId }),
					},
					context,
				);
				return {
					accepted: true,
					operationId: String(submission.id),
					error: null,
				};
			} catch (error) {
				return {
					accepted: false,
					operationId: null,
					error: toAgentError(error),
				};
			}
		},
		steer: (request, context) => queue("steer", request, context),
		followUp: (request, context) => queue("followUp", request, context),
		async cancelQueued(entryId, context) {
			const id = parseRecordId<SubmissionId>(entryId);
			if (id === undefined) return { outcome: "not_found" };
			const result = await harness.abortSubmission(id, context, conversation().id);
			return {
				outcome: result === "aborted" ? "cancelled" : result === "not_found" ? "not_found" : "already_consumed",
			};
		},
		abort: (context) => conversation().abort(context),
		async cancelPrompt(operationId, context) {
			const id = parseRecordId<SubmissionId>(operationId);
			return {
				outcome: id === undefined ? "not_found" : await harness.cancelPrompt(id, context),
			};
		},
		async compact(request, context) {
			const refusal = admission?.();
			if (refusal !== undefined) return { accepted: false, operationId: null, error: refusal };
			try {
				const id = await conversation().compact(request.customInstructions ?? undefined, context);
				return { accepted: true, operationId: String(id), error: null };
			} catch (error) {
				return {
					accepted: false,
					operationId: null,
					error: toAgentError(error),
				};
			}
		},
		async waitForPrompt(operationId, context): Promise<AgentPromptResult> {
			const id = parseRecordId<SubmissionId>(operationId);
			const submission = id === undefined ? undefined : await harness.submission(id, context);
			if (submission === undefined) throw new Error(`Unknown prompt: ${operationId}`);
			const settled = await submission.wait(context);
			if (settled.status === "unanswered") return { status: "unanswered", text: null, reason: settled.reason };
			const answer = settled.type === "input" ? settled.answer : undefined;
			const message =
				answer === undefined ? undefined : (await harness.commit((tx) => tx.entry(answer), context))?.model?.[0];
			const text =
				message?.role === "assistant"
					? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("")
					: "";
			return { status: "done", text, reason: null };
		},
		async findPrompt(conversationId, requestId, context) {
			const id = parseRecordId<ConversationId>(conversationId);
			if (id === undefined) return null;
			const receipt = await harness.commit((tx) => tx.submissionByRequest(id, requestId), context);
			return receipt === undefined ? null : String(receipt.id);
		},
	};
}

function parseRecordId<T extends ConversationId | SubmissionId>(value: string): T | undefined {
	const id = Number(value);
	return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(id) ? (id as T) : undefined;
}

function toInput(request: AgentPromptRequest): UserInput {
	if (request.images === null || request.images.length === 0) return request.message;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: request.message }, ...request.images];
	return content;
}

function toAgentError(error: unknown): AgentOperationError {
	if (error instanceof ConversationBusy) return { code: "busy", message: error.message };
	if (error instanceof UnknownConversation) return { code: "target_missing", message: error.message };
	return {
		code: "operation_failed",
		message: error instanceof Error ? error.message : String(error),
	};
}
