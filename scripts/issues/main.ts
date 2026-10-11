// Issue triage: sync issues, triage new ones with a @amazme/durable agent, and serve a small web UI for decisions.
// See README.md.
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@amazme/ai";
import { Corpus, issueStatus } from "./github.ts";
import { PRIORITIES, type Priority, Triage } from "./triage.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.TRIAGE_DATA ?? join(scriptDir, "data");
const [provider, ...modelParts] = (
	process.env.TRIAGE_MODEL ?? "openai-codex/gpt-5.6-sol"
).split("/");
const modelId = modelParts.join("/");
if ((provider !== "openai-codex" && provider !== "anthropic") || !modelId)
	throw new Error("TRIAGE_MODEL must be openai-codex/model or anthropic/model");
const syncMinutes = Number(process.env.TRIAGE_SYNC_MINUTES ?? 20);
if (!Number.isFinite(syncMinutes) || syncMinutes <= 0)
	throw new Error("TRIAGE_SYNC_MINUTES must be positive");
const thinking = process.env.TRIAGE_THINKING ?? "medium";
const thinkingLevels: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
if (!thinkingLevels.includes(thinking as ModelThinkingLevel))
	throw new Error("Invalid TRIAGE_THINKING");
const socket = process.env.TRIAGE_SOCKET;
const port = Number(process.env.TRIAGE_PORT ?? 7788);
if (socket && existsSync(socket))
	throw new Error("TRIAGE_SOCKET already exists");
if (!socket && (!Number.isInteger(port) || port < 0 || port > 65535))
	throw new Error("Invalid TRIAGE_PORT");

const corpus = new Corpus(
	join(dataDir, "corpus.json"),
	Number(process.env.TRIAGE_CORPUS_DAYS ?? 120),
);
const triage = new Triage({
	dataDir,
	scriptDir,
	corpus,
	model: { provider, modelId },
	thinkingLevel: thinking as ModelThinkingLevel,
	concurrency: Number(process.env.TRIAGE_CONCURRENCY ?? 4),
	inboxDays: Number(process.env.TRIAGE_INBOX_DAYS ?? 2),
});
mkdirSync(dataDir, { recursive: true });
await triage.open();

const tokenPath = join(dataDir, "token");
if (!existsSync(tokenPath))
	writeFileSync(tokenPath, randomBytes(24).toString("hex"), { mode: 0o600 });
const token = readFileSync(tokenPath, "utf8").trim();

const sync = { running: false, lastSync: "", lastError: "", lastCount: 0 };
async function runSync(): Promise<void> {
	if (sync.running) return;
	sync.running = true;
	try {
		sync.lastCount = await corpus.sync();
		sync.lastSync = new Date().toISOString();
		sync.lastError = "";
		await triage.enqueueInbox();
	} catch (error) {
		sync.lastError = error instanceof Error ? error.message : String(error);
		console.error("sync:", error);
	} finally {
		sync.running = false;
	}
}

async function view() {
	const state = await triage.state();
	const items = corpus
		.all()
		.filter((issue) => issue.createdAt >= state.inboxSince)
		.sort((a, b) => b.number - a.number)
		.map((issue) => {
			const entry = state.issues[issue.number];
			const result = entry?.result
				? {
						...entry.result,
						duplicates: entry.result.duplicates.map((dup) => {
							const other = corpus.get(dup.number);
							return {
								...dup,
								title: other?.title ?? "",
								status: other ? issueStatus(other) : "",
							};
						}),
					}
				: null;
			return {
				number: issue.number,
				title: issue.title,
				author: issue.author,
				association: issue.association,
				status: issueStatus(issue),
				createdAt: issue.createdAt,
				body: issue.body.slice(0, 4000),
				authorStats: corpus.authorStats(issue),
				triage: entry
					? { status: entry.status, error: entry.error, result }
					: null,
				decision: entry?.decision ?? null,
			};
		});
	return {
		repo: corpus.repo,
		model: `${provider}/${modelId}`,
		inboxSince: state.inboxSince,
		categories: triage.categories.map(({ name, owner }) => ({ name, owner })),
		sync,
		queue: triage.queueSize(),
		cost: await triage.usageCost(),
		items,
	};
}

function authorized(req: IncomingMessage): boolean {
	const cookie =
		/(?:^|;\s*)triage=([0-9a-f]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
	return (
		cookie.length === token.length &&
		timingSafeEqual(Buffer.from(cookie), Buffer.from(token))
	);
}

async function readJson(
	req: IncomingMessage,
): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
		string,
		unknown
	>;
}

function send(
	res: ServerResponse,
	status: number,
	body: string,
	type = "application/json",
): void {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
	res.end(body);
}

async function handle(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.searchParams.get("t") === token) {
		res.writeHead(302, {
			"set-cookie": `triage=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`,
			location: "/",
		});
		res.end();
		return;
	}
	if (!authorized(req))
		return send(res, 401, "Open the link with ?t=<token> once.", "text/plain");

	if (req.method === "GET" && url.pathname === "/") {
		return send(
			res,
			200,
			readFileSync(join(scriptDir, "ui.html"), "utf8"),
			"text/html; charset=utf-8",
		);
	}
	if (req.method === "GET" && url.pathname === "/api/state")
		return send(res, 200, JSON.stringify(await view()));
	if (req.method === "POST" && url.pathname === "/api/sync") {
		void runSync();
		return send(res, 202, "{}");
	}
	if (req.method === "POST" && url.pathname === "/api/retriage") {
		const { number } = await readJson(req);
		if (
			!Number.isSafeInteger(number) ||
			corpus.get(number as number) === undefined
		)
			return send(res, 400, '{"error":"bad issue"}');
		if ((await triage.state()).issues[number as number]?.status === "running")
			return send(res, 409, '{"error":"triage is running"}');
		await triage.retriage(Number(number));
		return send(res, 200, "{}");
	}
	if (req.method === "POST" && url.pathname === "/api/decide") {
		const body = await readJson(req);
		const priority = body.priority as Priority | null | undefined;
		const category = body.category as string | null | undefined;
		if (priority != null && !PRIORITIES.includes(priority))
			return send(res, 400, '{"error":"bad priority"}');
		if (
			category != null &&
			!triage.categories.some((c) => c.name === category)
		) {
			return send(res, 400, '{"error":"bad category"}');
		}
		const numbers = Array.isArray(body.numbers) ? body.numbers : [body.number];
		if (
			numbers.length === 0 ||
			numbers.some(
				(number) =>
					!Number.isSafeInteger(number) ||
					corpus.get(number as number) === undefined,
			)
		)
			return send(res, 400, '{"error":"bad issue"}');
		for (const number of numbers)
			await triage.decide(number as number, { priority, category });
		return send(res, 200, "{}");
	}
	send(res, 404, '{"error":"not found"}');
}

const server = createServer((req, res) => {
	handle(req, res).catch((error: unknown) => {
		console.error(error);
		if (!res.headersSent)
			send(res, 500, JSON.stringify({ error: String(error) }));
	});
});
if (socket) {
	server.listen(socket, () => chmodSync(socket, 0o660));
	console.log(`listening on ${socket}, token in ${tokenPath}`);
} else {
	server.listen(port, "127.0.0.1", () => {
		const address = server.address();
		if (address && typeof address !== "string")
			console.log(
				`http://127.0.0.1:${address.port}/?t=<token from ${tokenPath}>`,
			);
	});
}

void runSync();
const syncTimer = setInterval(() => void runSync(), syncMinutes * 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		clearInterval(syncTimer);
		server.close();
		void triage.close().finally(() => process.exit(0));
	});
}
