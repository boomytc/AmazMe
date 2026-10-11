import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createTwoFilesPatch, diffLines } from "diff";
import type { Context } from "@amazme/chord";
import { defineExtension, GenerationTask, hook, LiveDoc, ToolTask } from "@amazme/durable";
import type { ConversationId, Harness, HookApi } from "@amazme/durable";
import { getAgentDir } from "../../config.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { ReviewDoc } from "./state.ts";
import type { FileChange, FileImage, ReviewState } from "./state.ts";

const runFile = promisify(execFile);
const MAX_FILES = 1500, MAX_FILE_BYTES = 256 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const OMIT = new Set([".git", ".amazme", "node_modules", "dist", "build", ".next", "__pycache__"]);
type Snapshot = { files: FileImage[]; skipped: number; notes: string[]; omitted: string[]; incomplete: string[] };
const fileKey = (root: string, path: string): string => `${root}\0${path}`;

async function fileNames(root: string): Promise<{ names: string[]; complete: boolean }> {
	try {
		const { stdout } = await runFile("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
		return { names: [...new Set(stdout.split("\0").filter(Boolean))], complete: true };
	} catch {
		const paths: string[] = [];
		const visit = async (path: string): Promise<void> => {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (OMIT.has(entry.name)) continue;
				if (paths.length > MAX_FILES) return;
				if (entry.isDirectory()) await visit(join(path, entry.name));
				else if (entry.isFile()) paths.push(relative(root, join(path, entry.name)));
			}
		};
		await visit(root);
		return { names: paths, complete: paths.length <= MAX_FILES };
	}
}

async function capture(roots: readonly string[], context: Context, artifacts?: string): Promise<Snapshot> {
	const snapshot: Snapshot = { files: [], skipped: 0, notes: [], omitted: [], incomplete: [] };
	const seen = new Set<string>();
	let bytes = 0;
	for (const root of roots) {
		let names: string[];
		try { const listing = await fileNames(root); names = listing.names; if (!listing.complete) snapshot.incomplete.push(root); }
		catch { snapshot.notes.push(`无法读取目录：${root}`); snapshot.incomplete.push(root); continue; }
		for (const name of names.sort()) {
			context.abortSignal?.throwIfAborted();
			const path = resolve(root, name);
			if (seen.has(path)) continue;
			if (artifacts && (path === artifacts || path.startsWith(`${artifacts}/`))) continue;
			const omit = (): void => { snapshot.skipped++; snapshot.omitted.push(fileKey(root, name)); };
			const local = relative(root, path);
			if (local === ".." || local.startsWith(`..${sep}`) || name.split(/[\\/]/).some(part => OMIT.has(part))) { omit(); continue; }
			try {
				const info = await lstat(path);
				if (!info.isFile()) { omit(); continue; }
				if (snapshot.files.length >= MAX_FILES || info.size > MAX_FILE_BYTES || bytes + info.size > MAX_TOTAL_BYTES) { omit(); continue; }
				const content = await readFile(path);
				bytes += content.length;
				snapshot.files.push({ root, path: name, hash: createHash("sha256").update(content).digest("hex"), text: content.includes(0) ? null : content.toString("utf8"), size: content.length });
				seen.add(path);
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") omit(); }
		}
	}
	if (snapshot.incomplete.length) snapshot.notes.push("部分目录未完整遍历，仅显示有完整前后记录的变化。");
	return snapshot;
}

async function save(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path); }
	finally { await rm(temporary, { force: true }); }
}

function compare(before: Snapshot, after: Snapshot): FileChange[] {
	const key = (file: FileImage): string => fileKey(file.root, file.path);
	const old = new Map(before.files.map(file => [key(file), file])), next = new Map(after.files.map(file => [key(file), file]));
	const omitted = new Set([...(before.omitted ?? []), ...(after.omitted ?? [])]);
	const changes: FileChange[] = [];
	for (const name of new Set([...old.keys(), ...next.keys()])) {
		const previous = old.get(name), current = next.get(name), file = current ?? previous!;
		if (omitted.has(name) || (!previous && before.incomplete?.includes(file.root)) || (!current && after.incomplete?.includes(file.root))) continue;
		if (previous?.hash === current?.hash) continue;
		const binary = previous?.text === null || current?.text === null;
		const parts = binary ? [] : diffLines(previous?.text ?? "", current?.text ?? "");
		changes.push({ root: file.root, path: file.path, kind: !previous ? "added" : !current ? "removed" : "modified", binary,
			added: parts.reduce((sum, part) => sum + (part.added ? part.count ?? 0 : 0), 0), removed: parts.reduce((sum, part) => sum + (part.removed ? part.count ?? 0 : 0), 0),
			diff: binary ? "二进制文件已变化。" : createTwoFilesPatch(`a/${file.path}`, `b/${file.path}`, previous?.text ?? "", current?.text ?? "").slice(0, 128 * 1024) });
	}
	return changes.sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path));
}

export async function readReview(harness: Harness, conversationId: ConversationId, context: Context): Promise<{ state: Readonly<ReviewState> | undefined; files: FileChange[] }> {
	const state = await harness.snapshot(ReviewDoc, conversationId, context);
	if (!state?.result) return { state, files: [] };
	try { return { state, files: JSON.parse(await readFile(state.result, "utf8")) as FileChange[] }; }
	catch { return { state: { ...state, notes: [...state.notes, "变更记录无法读取。"] }, files: [] }; }
}

export async function refreshReview(harness: Harness, conversationId: ConversationId, context: Context): Promise<void> {
	if ((await harness.snapshot(LiveDoc, conversationId, context))?.run) return;
	const state = await harness.snapshot(ReviewDoc, conversationId, context);
	if (!state?.baseline || !state.result) return;
	const before = JSON.parse(await readFile(state.baseline, "utf8")) as Snapshot;
	const after = await capture(state.roots, context, dirname(state.baseline));
	await save(state.result, compare(before, after));
	await harness.commit(async tx => { const doc = await tx.doc(ReviewDoc, conversationId); if (doc.run !== state.run) return; doc.revision = (doc.revision ?? 0) + 1; doc.skipped = before.skipped + after.skipped; doc.notes = [...before.notes, ...after.notes]; }, context);
}

export function createWorkspaceReview(settings: SettingsManager, workspaces: () => Promise<readonly string[]>, directory = join(getAgentDir(), "review", randomUUID())) {
	let tail = Promise.resolve();
	const serialize = (operation: () => Promise<void>): Promise<void> => { const result = tail.catch(() => {}).then(operation); tail = result; return result; };
	const ensure = (api: HookApi, context: Context): Promise<void> => serialize(async () => {
		const run = String((await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs[0] ?? "");
		if (!run) return;
		const state = await api.snapshot(ReviewDoc, api.conversationId, context);
		if (settings.getSettings().reviewChanges === false) {
			if (state?.run !== run) await api.commit(async tx => { Object.assign(await tx.doc(ReviewDoc, api.conversationId), ReviewDoc.definition.initial(), { run, at: Date.now(), notes: ["本轮未开启变更记录。"] }); }, context);
			return;
		}
		const roots = [...new Set(await workspaces())];
		if (state?.run === run && state.baseline && roots.every(root => state.roots.includes(root))) return;
		const added = state?.run === run ? roots.filter(root => !state.roots.includes(root)) : roots;
		const fresh = await capture(added, context, directory);
		const previous = state?.run === run && state.baseline ? JSON.parse(await readFile(state.baseline, "utf8")) as Snapshot : undefined;
		const images = [...previous?.files ?? [], ...fresh.files];
		const snapshot: Snapshot = { files: [...new Map(images.toReversed().map(file => [resolve(file.root, file.path), file])).values()], skipped: (previous?.skipped ?? 0) + fresh.skipped,
			omitted: [...previous?.omitted ?? [], ...fresh.omitted], incomplete: [...previous?.incomplete ?? [], ...fresh.incomplete],
			notes: [...previous?.notes ?? [], ...fresh.notes, ...(previous ? ["回合中加入的目录，从加入时开始比较。"] : state?.run === run ? ["回合中启用记录，从启用时开始比较。"] : [])] };
		const base = join(directory, `${api.conversationId}-${run}`);
		await save(`${base}-before.json`, snapshot);
		await save(`${base}-changes.json`, []);
		await api.commit(async tx => { Object.assign(await tx.doc(ReviewDoc, api.conversationId), { revision: (state?.revision ?? 0) + 1, run, at: state?.run === run ? state.at : Date.now(), roots: [...new Set([...(state?.run === run ? state.roots : []), ...roots])], baseline: `${base}-before.json`, result: `${base}-changes.json`, skipped: snapshot.skipped, notes: snapshot.notes, verification: state?.run === run ? state.verification ?? [] : [] }); }, context);
	});
	const refresh = (api: HookApi, context: Context): Promise<void> => serialize(async () => {
		if (settings.getSettings().reviewChanges === false) return;
		const state = await api.snapshot(ReviewDoc, api.conversationId, context);
		if (!state?.baseline || !state.result) return;
		const before = JSON.parse(await readFile(state.baseline, "utf8")) as Snapshot, after = await capture(state.roots, context, directory);
		await save(state.result, compare(before, after));
		await api.commit(async tx => { const doc = await tx.doc(ReviewDoc, api.conversationId); doc.revision = (doc.revision ?? 0) + 1; doc.skipped = before.skipped + after.skipped; doc.notes = [...before.notes, ...after.notes]; }, context);
	});
	const safe = async (operation: Promise<void>, api: HookApi, context: Context): Promise<void> => {
		try { await operation; }
		catch {
			context.abortSignal?.throwIfAborted();
			const run = String((await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs[0] ?? "");
			await api.commit(async tx => {
				const doc = await tx.doc(ReviewDoc, api.conversationId);
				if (doc.run !== run) Object.assign(doc, ReviewDoc.definition.initial(), { run, at: Date.now() });
				doc.revision = (doc.revision ?? 0) + 1; doc.notes = ["本轮变更记录不完整，请直接检查工作区。"];
			}, context);
		}
	};
	return defineExtension({ name: "workspace-review", hooks: [
		hook(GenerationTask, { beforeRequest: async (_request, api, context) => { await safe(ensure(api, context), api, context); }, afterTools: async (_assistant, _results, api, context) => { await safe(refresh(api, context), api, context); }, onYield: async (_answer, api, context) => { await safe(refresh(api, context), api, context); } }),
		hook(ToolTask, {
			beforeTool: async (_call, api, context) => { await safe(ensure(api, context), api, context); },
			async afterTool(call, result, api, context) {
				const command = call.arguments.command;
				if (settings.getSettings().reviewChanges === false || call.name !== "bash" || typeof command !== "string" || /[;&|\n]/.test(command)
					|| !/^\s*(npm (test|run (test|build|check|typecheck|lint))|pnpm (test|build|check|typecheck|lint)|pytest|cargo (test|check)|go test|npx tsc)\b/.test(command)) return;
				const output = result.structuredOutput;
				const details = result.details;
				const exitCode = output !== null && typeof output === "object" && !Array.isArray(output) && typeof output.exitCode === "number" ? output.exitCode
					: details !== null && typeof details === "object" && !Array.isArray(details) && typeof details.exit_code === "number" ? details.exit_code : null;
				await api.commit(async tx => { const state = await tx.doc(ReviewDoc, api.conversationId); state.verification = [...state.verification ?? [], { command, exitCode, at: Date.now() }].slice(-20); }, context);
			},
		}),
	] });
}
