import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_SESSION_DIR } from "../src/config.ts";
import { createTempDir } from "./temp-dir.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "support/legacy-durable-cli.ts");

interface Run {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

describe.skipIf(process.platform === "win32")("durable explicit session", () => {
	let directory: string;
	let projectA: string;
	let projectB: string;
	let profile: string;
	let sessionDir: string;
	let server: Server;
	let requests: string[];

	beforeEach(async () => {
		directory = createTempDir("amazme-session-select-");
		projectA = join(directory, "project-a");
		projectB = join(directory, "project-b");
		profile = join(directory, "profile");
		sessionDir = join(directory, "sessions");
		requests = [];
		await mkdir(projectA);
		await mkdir(projectB);
		await mkdir(profile);
		await writeFile(join(projectA, "AGENTS.md"), "PROJECT_A_AGENTS\n");
		await writeFile(join(projectB, "AGENTS.md"), "PROJECT_B_AGENTS\n");
		server = createServer((request, response) => {
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				requests.push(Buffer.concat(chunks).toString("utf8"));
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(
					`data: ${JSON.stringify({
						id: "fixture",
						object: "chat.completion.chunk",
						created: 0,
						model: "scripted",
						choices: [{ index: 0, delta: { role: "assistant", content: "fixture answer" }, finish_reason: null }],
					})}\n\n`,
				);
				response.write(
					`data: ${JSON.stringify({
						id: "fixture",
						object: "chat.completion.chunk",
						created: 0,
						model: "scripted",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\n`,
				);
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		await writeFile(
			join(profile, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
						api: "openai-completions",
						apiKey: "fixture-key",
						models: [
							{
								id: "scripted",
								name: "Scripted",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 200000,
								maxTokens: 8192,
							},
						],
					},
				},
			}),
		);
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
		await rm(directory, { recursive: true, force: true });
	});

	async function run(
		cwd: string,
		args: readonly string[],
		options: { readonly cliSessionDir?: boolean } = {},
	): Promise<Run> {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			AMAZME_CODING_AGENT_DIR: profile,
			AMAZME_DURABLE_TUI: "1",
			AMAZME_OFFLINE: "1",
		};
		if (options.cliSessionDir === false) delete env[ENV_SESSION_DIR];
		const child: ChildProcess = spawn(
			process.execPath,
			[
				"--import",
				sourceResolverUrl,
				cliPath,
				"--offline",
				"--provider",
				"fixture",
				"--model",
				"scripted",
				"--api-key",
				"fixture-key",
				...(options.cliSessionDir === false ? [] : ["--session-dir", sessionDir]),
				"--no-extensions",
				"--no-mcp",
				...args,
			],
			{
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const stdout: string[] = [];
		const stderr: string[] = [];
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
		const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
		return { code, stdout: stdout.join(""), stderr: stderr.join("") };
	}

	/** The one directory holding this project's sessions in the explicit root. */
	async function group(): Promise<string> {
		const roots = (await readdir(sessionDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
		expect(roots).toHaveLength(1);
		return join(sessionDir, roots[0]!.name);
	}

	async function exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}

	async function ids(): Promise<string[]> {
		const root = await group();
		return (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	}

	it("opens an existing ID in place and never creates another session", async () => {
		const created = await run(projectA, ["--print", "create"]);
		expect(created.code, created.stderr).toBe(0);
		const [id] = await ids();
		const opened = await run(projectA, ["--session", id!, "--print", "second"]);
		expect(opened.code, opened.stderr).toBe(0);
		expect(opened.stdout).toContain("fixture answer");
		expect(await ids()).toEqual([id]);
	});

	it("finds an explicit ID through the sessionDir setting", async () => {
		await mkdir(join(projectA, ".amazme"), { recursive: true });
		await writeFile(join(projectA, ".amazme", "settings.json"), JSON.stringify({ sessionDir }));
		const created = await run(projectA, ["--approve", "--print", "create"], { cliSessionDir: false });
		expect(created.code, created.stderr).toBe(0);
		const [id] = await ids();
		const opened = await run(projectA, ["--approve", "--session", id!, "--print", "second"], {
			cliSessionDir: false,
		});
		expect(opened.code, opened.stderr).toBe(0);
		expect(opened.stdout).toContain("fixture answer");
		expect(await ids()).toEqual([id]);
	});

	it("fails without creating anything when the ID is missing", async () => {
		await run(projectA, ["--print", "create"]);
		const before = await ids();
		const missing = await run(projectA, ["--session", "00000000-0000-4000-8000-000000000000", "--print", "no"]);
		expect(missing.code).not.toBe(0);
		expect(missing.stderr).toContain("No durable session matches");
		expect(await ids()).toEqual(before);
	});

	it("fails when a UUID part matches more than one session", async () => {
		await run(projectA, ["--print", "create"]);
		const root = await group();
		const [id] = await ids();
		const uuid = id!.slice(14);
		const twin = `9999999999999-${uuid}`;
		await cp(join(root, id!), join(root, twin), { recursive: true });
		const ambiguous = await run(projectA, ["--session", uuid, "--print", "no"]);
		expect(ambiguous.code).not.toBe(0);
		expect(ambiguous.stderr).toContain("ambiguous");
		expect(await ids()).toHaveLength(2);
	});

	it("opens a session directory from another cwd with the recorded project's settings and resources", async () => {
		await run(projectA, ["--print", "create"]);
		const root = await group();
		const [id] = await ids();
		expect(requests.at(-1)).toContain("PROJECT_A_AGENTS");

		await mkdir(join(projectA, ".amazme", "commands"), { recursive: true });
		await mkdir(join(projectB, ".amazme", "commands"), { recursive: true });
		await writeFile(join(projectA, ".amazme", "commands", "legacy.md"), "PROJECT_A_COMMAND\n");
		await writeFile(join(projectB, ".amazme", "commands", "legacy.md"), "PROJECT_B_COMMAND\n");
		requests.length = 0;
		const opened = await run(projectB, ["--approve", "--session", join(root, id!), "--print", "from elsewhere"]);
		expect(opened.code, opened.stderr).toBe(0);
		expect(opened.stdout).toContain("fixture answer");
		expect(requests.at(-1)).toContain("PROJECT_A_AGENTS");
		expect(requests.at(-1)).not.toContain("PROJECT_B_AGENTS");
		expect(await ids()).toEqual([id]);
		expect(await exists(join(projectA, ".amazme", "prompts", "legacy.md"))).toBe(true);
		expect(await exists(join(projectA, ".amazme", "commands"))).toBe(false);
		expect(await exists(join(projectB, ".amazme", "commands", "legacy.md"))).toBe(true);
		expect(await exists(join(projectB, ".amazme", "prompts"))).toBe(false);
	});

	it("rejects --session combined with --continue", async () => {
		await run(projectA, ["--print", "create"]);
		const [id] = await ids();
		const conflict = await run(projectA, ["--session", id!, "--continue", "--print", "no"]);
		expect(conflict.code).not.toBe(0);
		expect(conflict.stderr).toContain("--session cannot be combined");
		expect(await ids()).toEqual([id]);
	});

	it("keeps the session directory name as the session id", async () => {
		await run(projectA, ["--print", "create"]);
		const [id] = await ids();
		expect(basename(id!)).toMatch(/^\d{13}-[0-9a-f-]{36}$/u);
	});
});
