import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@amazme/ai";
import { Corpus, type Issue, issueStatus } from "./github.ts";
import { Triage, type TriageResult } from "./triage.ts";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));

function issue(number: number, extra: Partial<Issue> = {}): Issue {
	return {
		number,
		title: "nested tool abort leaves a running task",
		body: "executeTool cancellation after restart",
		state: "open",
		stateReason: null,
		labels: ["bug"],
		author: "tester",
		association: "NONE",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		comments: 0,
		...extra,
	};
}

test("corpus sync is incremental, repository-bound, searchable and atomic on failure", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "amazme-issue-corpus-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "corpus.json");
	const calls: string[][] = [];
	let response = [
		issue(1, { state: "closed", stateReason: "completed" }),
		issue(2),
	]
		.map((value) => JSON.stringify(value))
		.join("\n");
	const corpus = new Corpus(path, 120, {
		repo: "owner/repo",
		request: async (args) => {
			calls.push(args);
			return response;
		},
	});
	const since = corpus.syncedAt;
	assert.equal(await corpus.sync(), 2);
	assert.ok(calls[0]?.includes("repos/owner/repo/issues"));
	assert.ok(calls[0]?.includes(`since=${since}`));
	assert.deepEqual(
		corpus.search("executeTool cancellation", 2).map((value) => value.number),
		[1],
	);
	assert.deepEqual(corpus.authorStats(corpus.get(2)!), {
		prior: 1,
		actedOn: 1,
	});
	assert.equal(issueStatus(corpus.get(1)!), "closed:completed");
	const snapshot = readFileSync(path, "utf8");
	response = `${JSON.stringify(issue(3))}\ninvalid-json`;
	await assert.rejects(corpus.sync());
	assert.equal(corpus.get(3), undefined);
	assert.equal(readFileSync(path, "utf8"), snapshot);
	assert.equal(new Corpus(path, 120, { repo: "owner/repo" }).all().length, 2);
	assert.throws(
		() => new Corpus(path, 120, { repo: "other/repo" }),
		/repository differs/,
	);
});

const result: TriageResult = {
	category: "durable",
	confidence: "high",
	alternative: "",
	summary: "A nested task stays running after its owner is cancelled.",
	signals: ["repro steps"],
	duplicates: [{ number: 1, kind: "duplicate", reason: "self" }],
	suggestion: "p0",
	reason: "The task cannot settle.",
};
const answer = () =>
	fauxAssistantMessage([fauxToolCall("submit_triage", result)], {
		stopReason: "toolUse",
	});

async function eventually(
	check: () => boolean | Promise<boolean>,
): Promise<void> {
	for (let n = 0; n < 1000; n++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Condition was not reached");
}

test("triage uses SQLite, keeps decisions after reopen, deduplicates sync and admits a new attempt", async (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "amazme-issue-triage-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const corpus = new Corpus(join(dataDir, "corpus.json"), 120, {
		request: async () => JSON.stringify(issue(1)),
	});
	await corpus.sync();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([answer(), answer()]);
	const options = {
		dataDir,
		scriptDir,
		corpus,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off" as const,
		concurrency: 1,
		inboxDays: 2,
	};
	let triage = new Triage(options);
	try {
		await triage.open(models);
		await Promise.all([triage.enqueueInbox(), triage.enqueueInbox()]);
		await eventually(
			async () =>
				(await triage.state()).issues[1]?.status === "done" &&
				triage.queueSize().running === 0,
		);
		const first = (await triage.state()).issues[1]!;
		assert.deepEqual(first.result?.duplicates, []);
		assert.equal(faux.state.callCount, 1);
		await triage.decide(1, { priority: "p1", category: "tools" });
		await assert.rejects(
			triage.decide(999, { priority: "p0" }),
			/not in the corpus/,
		);
		await triage.close();
		triage = new Triage(options);
		await triage.open(models);
		assert.equal((await triage.state()).issues[1]?.decision?.category, "tools");
		await triage.enqueueInbox();
		assert.equal(faux.state.callCount, 1);
		await triage.retriage(1);
		await eventually(
			async () =>
				(await triage.state()).issues[1]?.status === "done" &&
				triage.queueSize().running === 0,
		);
		const second = (await triage.state()).issues[1]!;
		assert.equal(second.attempt, 1);
		assert.notEqual(second.conversationId, first.conversationId);
		assert.equal(second.decision?.priority, "p1");
		assert.equal(faux.state.callCount, 2);
		await triage.decide(1, { priority: null, category: null });
		assert.equal((await triage.state()).issues[1]?.decision, null);
	} finally {
		await triage.close();
	}
});

test("unfinished triage resumes after close and disallows a competing retriage", async (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "amazme-issue-recovery-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const corpus = new Corpus(join(dataDir, "corpus.json"), 120, {
		request: async () => JSON.stringify(issue(1)),
	});
	await corpus.sync();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		async (_context, options) => {
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else
					options?.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
			});
			return fauxAssistantMessage("stopped", { stopReason: "aborted" });
		},
	]);
	const options = {
		dataDir,
		scriptDir,
		corpus,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off" as const,
		concurrency: 1,
		inboxDays: 2,
	};
	let triage = new Triage(options);
	try {
		await triage.open(models);
		await triage.enqueueInbox();
		await eventually(() => faux.state.callCount === 1);
		await assert.rejects(triage.retriage(1), /still running/);
		const id = (await triage.state()).issues[1]!.conversationId;
		await triage.close();
		faux.setResponses([answer()]);
		triage = new Triage(options);
		await triage.open(models);
		await eventually(
			async () => (await triage.state()).issues[1]?.status === "done",
		);
		assert.equal((await triage.state()).issues[1]?.conversationId, id);
	} finally {
		await triage.close();
	}
});

test("HTTP source entry starts locally, requires authentication and stores decisions without GitHub writes", async (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "amazme-issue-http-"));
	const old = issue(1);
	const corpus = new Corpus(join(dataDir, "corpus.json"), 120, {
		repo: "owner/repo",
		request: async () => JSON.stringify(old),
	});
	await corpus.sync();
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([answer()]);
	const seed = new Triage({
		dataDir,
		scriptDir,
		corpus,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
		concurrency: 1,
		inboxDays: 2,
	});
	try {
		await seed.open(models);
		await seed.enqueueInbox();
		await eventually(
			async () => (await seed.state()).issues[1]?.status === "done",
		);
	} finally {
		await seed.close();
	}
	const ghPath = join(dataDir, "gh");
	writeFileSync(
		ghPath,
		`#!${process.execPath}\nif (process.argv[2] !== 'api' || !process.argv.includes('GET')) process.exit(91);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(old))});\n`,
		{ mode: 0o755 },
	);
	const child = spawn(
		process.execPath,
		[
			"--import",
			"./packages/coding-agent/src/source-resolver.ts",
			"scripts/issues/main.ts",
		],
		{
			cwd: fileURLToPath(new URL("../..", import.meta.url)),
			env: {
				...process.env,
				TRIAGE_REPO: "owner/repo",
				TRIAGE_DATA: dataDir,
				TRIAGE_PORT: "0",
				TRIAGE_SOCKET: "",
				AMAZME_CODING_AGENT_DIR: join(dataDir, "auth"),
				PATH: `${dataDir}:${process.env.PATH}`,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	let errors = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		errors += chunk.toString();
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const ended = once(child, "exit");
			child.kill("SIGTERM");
			await ended;
		}
		rmSync(dataDir, { recursive: true, force: true });
	});
	await eventually(() => {
		assert.equal(child.exitCode, null, errors);
		return /http:\/\/127\.0\.0\.1:\d+/.test(output);
	});
	const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)![0];
	assert.equal((await fetch(url)).status, 401);
	const token = readFileSync(join(dataDir, "token"), "utf8");
	const login = await fetch(`${url}/?t=${token}`, { redirect: "manual" });
	assert.equal(login.status, 302);
	assert.match(login.headers.get("set-cookie") ?? "", /HttpOnly/);
	const headers = {
		cookie: `triage=${token}`,
		"content-type": "application/json",
	};
	assert.match(await (await fetch(url, { headers })).text(), /AmazMe issues/);
	await eventually(async () => {
		const state = (await (
			await fetch(`${url}/api/state`, { headers })
		).json()) as { items: unknown[] };
		return state.items.length === 1;
	});
	const bad = await fetch(`${url}/api/decide`, {
		method: "POST",
		headers,
		body: JSON.stringify({ numbers: [1, 999], priority: "p0" }),
	});
	assert.equal(bad.status, 400);
	const unchanged = await (await fetch(`${url}/api/state`, { headers })).json() as { items: { decision: unknown }[] };
	assert.equal(unchanged.items[0]?.decision, null);
	const good = await fetch(`${url}/api/decide`, {
		method: "POST",
		headers,
		body: JSON.stringify({ number: 1, priority: "p1" }),
	});
	assert.equal(good.status, 200);
	const state = (await (
		await fetch(`${url}/api/state`, { headers })
	).json()) as {
		repo: string;
		queue: { running: number };
		items: { decision: { priority: string } }[];
	};
	assert.equal(state.repo, "owner/repo");
	assert.equal(state.items[0]?.decision.priority, "p1");
	assert.equal(state.queue.running, 0);
});
