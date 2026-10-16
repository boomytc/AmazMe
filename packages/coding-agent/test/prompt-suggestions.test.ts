import type { Model, AssistantMessage } from "@amazme/ai";
import { replicatedState, type AttachedReplicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@amazme/chord/context";
import { AssistantEntry, UserEntry, type ConversationId, type ConversationView, type EntryId } from "@amazme/durable";
import { afterEach, expect, test, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { parsePromptSuggestion, suggestPrompt } from "../src/host/services/prompt-suggestions.ts";

const model: Model<"openai-completions"> = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://localhost", input: ["text"], reasoning: false, contextWindow: 8000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const answer = (text: string): AssistantMessage => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
	content: [{ type: "text", text }], stopReason: "stop", timestamp: 1,
	usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
const safe = "请解释两种设计各自适用的场景。";

function setup() {
	const id = 1 as ConversationId;
	const value: ConversationView = { conversation: { id } as ConversationView["conversation"], docs: {}, entries: [
		{ id: 1 as EntryId, conversationId: id, kind: UserEntry.kind, model: [{ role: "user", content: "对比两种设计", timestamp: 0 }] },
		{ id: 2 as EntryId, conversationId: id, kind: AssistantEntry.kind, model: [{ ...answer("两种设计有不同的侧重点。"), content: [{ type: "thinking", thinking: "private chain" }, { type: "text", text: "两种设计有不同的侧重点。" }] }] },
	] };
	const state = replicatedState(value), dispose = vi.fn();
	const attached: AttachedReplicatedState<ConversationView> = { get value() { return state.value!; }, subscribe: state.subscribe.bind(state), dispose };
	const conversation = { id, viewState: vi.fn(async () => attached) };
	const completeSimple = vi.fn<ModelRuntime["completeSimple"]>().mockResolvedValue(answer(JSON.stringify({ suggestion: safe })));
	const lifetime = new AbortController();
	const options = { conversation, request: { conversationId: "1", answerEntryId: "2", locale: "zh" as const }, model, runtime: { completeSimple }, context, lifetime: lifetime.signal };
	return { options, state, completeSimple, dispose, lifetime };
}

afterEach(() => vi.useRealTimers());

test("parses only bounded plain read-only draft candidates", () => {
	expect(parsePromptSuggestion(JSON.stringify({ suggestion: safe }))).toBe(safe);
	for (const value of [null, "", "a".repeat(201), "请提交这些修改", "Run npm test", "Delete the file", "请授权执行", "a\nb", "`echo hello`", "/help", "<script>bad</script>"]) {
		expect(parsePromptSuggestion(JSON.stringify({ suggestion: value }))).toBeNull();
	}
	expect(parsePromptSuggestion("not JSON")).toBeNull();
	expect(parsePromptSuggestion('```json\n{"suggestion":"example"}\n```')).toBeNull();
});

test("uses the actual final user/answer with no thinking, tools or history writes", async () => {
	const { options, completeSimple, dispose } = setup();
	expect(await suggestPrompt(options)).toBe(safe);
	const [selected, input, request] = completeSimple.mock.calls[0]!;
	expect(selected).toBe(model); expect(input.messages).toHaveLength(1); expect(input.tools).toBeUndefined();
	expect(JSON.stringify(input)).not.toContain("private chain");
	expect(JSON.stringify(input)).toContain("对比两种设计");
	expect(request?.maxTokens).toBe(256); expect(request?.signal).toBeInstanceOf(AbortSignal);
	expect(dispose).toHaveBeenCalledOnce();
});

test("refuses wrong branches, stale answers and running conversations before spending tokens", async () => {
	const { options, completeSimple, state } = setup();
	expect(await suggestPrompt({ ...options, request: { ...options.request, conversationId: "other" } })).toBeNull();
	expect(await suggestPrompt({ ...options, request: { ...options.request, answerEntryId: "old" } })).toBeNull();
	state.change(context, draft => { draft.docs["amazme.live"] = { run: { taskId: "running" } }; });
	expect(await suggestPrompt(options)).toBeNull(); expect(completeSimple).not.toHaveBeenCalled();
});

test("cancels and drops output when a new turn starts or the caller leaves", async () => {
	for (const mode of ["turn", "caller", "lifetime"] as const) {
		const { options, state, completeSimple, dispose, lifetime } = setup();
		const pending = Promise.withResolvers<AssistantMessage>(); completeSimple.mockReturnValue(pending.promise);
		const caller = new AbortController();
		const result = suggestPrompt({ ...options, context: withAbortSignal(caller.signal, context) });
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledOnce());
		if (mode === "turn") state.change(context, draft => { draft.docs["amazme.live"] = { run: { taskId: "new" } }; });
		else if (mode === "caller") caller.abort(); else lifetime.abort();
		expect(await result).toBeNull();
		expect(completeSimple.mock.calls[0]![2]?.signal?.aborted).toBe(true);
		pending.resolve(answer(JSON.stringify({ suggestion: safe })));
		expect(dispose).toHaveBeenCalledOnce();
	}
});

test("times out with no automatic retries and releases its transcript subscription", async () => {
	vi.useFakeTimers();
	const { options, completeSimple, dispose } = setup();
	const pending = Promise.withResolvers<AssistantMessage>(); completeSimple.mockReturnValue(pending.promise);
	const result = suggestPrompt(options);
	await vi.advanceTimersByTimeAsync(12_001);
	expect(await result).toBeNull(); expect(completeSimple).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
	pending.resolve(answer("{}"));
});

test("provider errors, incomplete output and repeated user requests silently fall back", async () => {
	const { options, completeSimple } = setup();
	completeSimple.mockRejectedValueOnce(new Error("offline")); expect(await suggestPrompt(options)).toBeNull();
	completeSimple.mockResolvedValueOnce({ ...answer(JSON.stringify({ suggestion: safe })), stopReason: "length" });
	expect(await suggestPrompt(options)).toBeNull();
	completeSimple.mockResolvedValueOnce(answer(JSON.stringify({ suggestion: "对比两种设计" })));
	expect(await suggestPrompt(options)).toBeNull();
});
