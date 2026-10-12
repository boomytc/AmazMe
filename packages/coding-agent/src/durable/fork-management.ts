import type { Context, Draft } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { AgentDoc, InboxDoc, CompactionTask, defineDoc, defineExtension, GenerationTask, hook, ROOT_CONVERSATION_ID, ToolTask } from "@amazme/durable";
import type { ConversationId, Cursor, DocumentReader, Harness, HookApi, InboxState, SubmissionId, Tx } from "@amazme/durable";

export type ForkMetadata = { name?: string; archivedAt?: number };
const ARCHIVE_GATE = "archived-fork-gate";

/** Session-scoped keys do not inherit names or archive state when a new fork copies context. */
export const ForkManagementDoc = defineDoc<{ forks: Record<string, ForkMetadata> }>({
	kind: "amazme.forks", version: 1, scope: "session", initial: () => ({ forks: {} }),
});

export class ForkArchivedError extends Error {
	constructor() { super("分叉已归档；恢复后才能开始工作。"); }
}

interface ArchiveReader extends Pick<DocumentReader, "snapshot"> {
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown>;
}

/** Only ownership edges extend an archive. Fork ancestry is history, not task ownership. */
export function archivedForkInScope(
	id: string,
	forks: Readonly<Record<string, ForkMetadata>>,
	owners: ReadonlyMap<string, string>,
): string | undefined {
	const seen = new Set<string>();
	while (!seen.has(id)) {
		seen.add(id);
		if (forks[id]?.archivedAt !== undefined) return id;
		const owner = owners.get(id);
		if (owner === undefined) return undefined;
		id = owner;
	}
	return undefined;
}

/** A committed ownership read, shared by request admission and model/tool recovery hooks. */
export async function archivedFork(reader: ArchiveReader, id: ConversationId, context: Context): Promise<string | undefined> {
	const snapshot = await reader.snapshot(ForkManagementDoc, context);
	if (snapshot === undefined || !Object.values(snapshot.forks).some(fork => fork.archivedAt !== undefined)) return undefined;
	let result: string | undefined;
	await reader.commit(async tx => {
		const metadata = await tx.doc(ForkManagementDoc);
		const seen = new Set<ConversationId>();
		let current: ConversationId | undefined = id;
		while (current !== undefined && !seen.has(current)) {
			seen.add(current);
			if (metadata.forks[String(current)]?.archivedAt !== undefined) { result = String(current); break; }
			current = (await tx.conversation(current))?.owner?.conversationId;
		}
		return undefined;
	}, context);
	return result;
}

export async function assertConversationWritable(reader: ArchiveReader, id: ConversationId, context: Context): Promise<void> {
	if (await archivedFork(reader, id, context)) throw new ForkArchivedError();
}

/** Short admission transactions fence prompts/queues against the archive stamp, not task shutdown. */
const admissionTails = new WeakMap<Harness, Promise<void>>();
export function withConversationAdmission<T>(harness: Harness, context: Context, run: () => Promise<T>): Promise<T> {
	const previous = admissionTails.get(harness) ?? Promise.resolve();
	const operation = previous.then(() => { context.abortSignal?.throwIfAborted(); return run(); });
	const tail = operation.then(() => {}, () => {});
	admissionTails.set(harness, tail);
	void tail.then(() => { if (admissionTails.get(harness) === tail) admissionTails.delete(harness); });
	return operation;
}

const mutationTails = new WeakMap<Harness, Map<string, Promise<void>>>();
/** A restore of the same fork must wait until its archive has actually joined cancelled work. */
export function withForkMutation<T>(harness: Harness, id: string, run: () => Promise<T>): Promise<T> {
	let tails = mutationTails.get(harness);
	if (tails === undefined) { tails = new Map(); mutationTails.set(harness, tails); }
	const operations = tails;
	const operation = (operations.get(id) ?? Promise.resolve()).then(run);
	const tail = operation.then(() => {}, () => {});
	operations.set(id, tail);
	void tail.then(() => { if (operations.get(id) === tail) operations.delete(id); });
	return operation;
}

export function parseConversationId(value: string): ConversationId {
	const id = Number(value);
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(id)) throw new Error("无效的对话编号。");
	return id as ConversationId;
}

export async function changeForkMetadata(
	harness: Harness, id: string, change: (metadata: ForkMetadata) => void, context: Context, protect = false,
): Promise<void> {
	const conversationId = parseConversationId(id);
	await harness.commit(async tx => {
		const record = await tx.conversation(conversationId);
		if (record === undefined) throw new Error("分叉不存在。");
		if (record.id === ROOT_CONVERSATION_ID || record.owner !== undefined) throw new Error("只能管理人工分叉；主线和子代理对话不支持此操作。");
		const owners = new Map<string, string>();
		if (protect) {
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanConversations({}, 256, cursor);
				for (const item of page.items) if (item.owner) owners.set(String(item.id), String(item.owner.conversationId));
				cursor = page.next;
			} while (cursor !== undefined);
		}
		const document = await tx.doc(ForkManagementDoc);
		if (document.forks[id] === undefined) document.forks[id] = {};
		// Re-read the tracked child: an object assigned to a draft is copied, not mutated in place.
		change(document.forks[id]!);
		// Explicit extension lists must not silently omit the host's execution gate on recovery.
		if (protect) {
			const scope = [id, ...[...owners.keys()].filter(child => archivedForkInScope(child, { [id]: { archivedAt: 0 } }, owners) === id)];
			for (const child of scope) {
				const agent = await tx.doc(AgentDoc, parseConversationId(child));
				const selection = agent.extensions;
				if (selection === undefined) continue;
				if (Array.isArray(selection)) { if (!selection.includes(ARCHIVE_GATE)) selection.push(ARCHIVE_GATE); }
				else agent.extensions = { ...selection, add: [...new Set([...(selection.add ?? []), ARCHIVE_GATE])], remove: selection.remove?.filter(name => name !== ARCHIVE_GATE) ?? [] };
			}
			await withdrawQueuedWork(tx, scope);
		}
	}, context);
}

/** Cancellation follows durable ownership records, not a presentation's labels or fork history. */
export async function ownedConversationIds(harness: Harness, id: string): Promise<ReadonlySet<string>> {
	const owners = new Map<string, string>();
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit(tx => tx.scanConversations({}, 256, cursor), BACKGROUND_CONTEXT);
		for (const record of page.items) if (record.owner) owners.set(String(record.id), String(record.owner.conversationId));
		cursor = page.next;
	} while (cursor !== undefined);
	return new Set([id, ...[...owners.keys()].filter(child => archivedForkInScope(child, { [id]: { archivedAt: 0 } }, owners) === id)]);
}

/** Withdraw queued writes too: ordinary abort deliberately preserves them for the next boundary. */
async function withdrawQueuedWork(tx: Tx, scope: Iterable<string>): Promise<void> {
	const queues: Draft<InboxState>[] = [];
	const submissions: SubmissionId[] = [];
	for (const id of scope) {
		const inbox = await tx.doc(InboxDoc, parseConversationId(id));
		queues.push(inbox);
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanSubmissions({ conversationId: parseConversationId(id), status: "queued" }, 256, cursor);
			submissions.push(...page.items.map(record => record.id));
			cursor = page.next;
		} while (cursor !== undefined);
	}
	// Finish every table read before the first settlement writes a submission record.
	for (const id of submissions) tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
	for (const inbox of queues) inbox.items.splice(0);
}

export async function stopArchivedForkWork(harness: Harness, id: string): Promise<void> {
	const withdraw = async () => {
		const scope = await ownedConversationIds(harness, id);
		await withConversationAdmission(harness, BACKGROUND_CONTEXT, () => harness.commit(tx => withdrawQueuedWork(tx, scope), BACKGROUND_CONTEXT));
	};
	await withdraw();
	try { await (await harness.conversation(parseConversationId(id), BACKGROUND_CONTEXT))?.abort(BACKGROUND_CONTEXT, { background: true }); }
	finally { await withdraw(); }
}

/** Recovery cannot restart work left in an archived branch's durable queue. */
export async function abortArchivedForks(harness: Harness): Promise<void> {
	const metadata = await harness.snapshot(ForkManagementDoc, BACKGROUND_CONTEXT);
	for (const [id, fork] of Object.entries(metadata?.forks ?? {})) {
		if (fork.archivedAt === undefined) continue;
		await stopArchivedForkWork(harness, id);
	}
}

/** Installed in every coding registry, so direct/recovered model and tool work cannot bypass the gate. */
export function createForkArchiveGate() {
	const beforeModel = async (api: HookApi, context: Context) => {
		try { return await archivedFork(api, api.conversationId, context) ? { block: "分叉已归档；恢复后才能开始工作。" } : undefined; }
		catch { return { block: "无法确认分叉状态，请恢复宿主连接后重试。" }; }
	};
	return defineExtension({ name: ARCHIVE_GATE, hooks: [
		hook(GenerationTask, { beforeModel }),
		hook(CompactionTask, { beforeModel }),
		hook(ToolTask, { beforeTool: (_call, api, context) => beforeModel(api, context), beforeExecute: (_call, api, context) => beforeModel(api, context) }),
	] });
}
