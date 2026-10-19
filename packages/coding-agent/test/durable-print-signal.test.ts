import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");
const TAIL = "AMAZME_PRINT_TAIL_DONE";

/** Bytes of answer text before the marker; enough to fill a pipe and force pending raw-stdout writes. */
const PADDING = 600_000;

const signals: readonly { signal: NodeJS.Signals; code: number }[] = [
	{ signal: "SIGINT", code: 130 },
	{ signal: "SIGTERM", code: 143 },
	{ signal: "SIGHUP", code: 129 },
];

describe.skipIf(process.platform === "win32")("durable print signal shutdown", () => {
	let directory: string;
	let profile: string;
	let server: Server;
	let response: string;
	const children: ChildProcess[] = [];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "amazme-print-signal-"));
		profile = join(directory, "profile");
		await mkdir(profile);
		response = "x".repeat(PADDING);
		server = createServer((request, httpResponse) => {
			if (request.url !== "/v1/chat/completions") {
				httpResponse.writeHead(404).end();
				return;
			}
			request.resume();
			request.on("end", () => {
				httpResponse.writeHead(200, { "content-type": "text/event-stream" });
				for (let offset = 0; offset < response.length; offset += 300) {
					httpResponse.write(
						`data: ${JSON.stringify({
							id: "fixture",
							object: "chat.completion.chunk",
							created: 0,
							model: "scripted",
							choices: [{ index: 0, delta: { role: "assistant", content: response.slice(offset, offset + 300) }, finish_reason: null }],
						})}\n\n`,
					);
				}
				httpResponse.write(
					`data: ${JSON.stringify({
						id: "fixture",
						object: "chat.completion.chunk",
						created: 0,
						model: "scripted",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\n`,
				);
				httpResponse.end("data: [DONE]\n\n");
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
								contextWindow: 400_000,
								maxTokens: 200_000,
							},
						],
					},
				},
			}),
		);
	});

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.length = 0;
		server.closeAllConnections();
		await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
		await rm(directory, { recursive: true, force: true });
	});

	function start(): ChildProcess {
		const child = spawn(
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
				"--no-session",
				"--no-extensions",
				"--no-mcp",
				"--print",
				"--mode",
				"json",
				"say the long answer",
			],
			{
				cwd: directory,
				env: { ...process.env, AMAZME_CODING_AGENT_DIR: profile, AMAZME_OFFLINE: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		children.push(child);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		return child;
	}

	for (const { signal, code } of signals) {
		it(`drains the complete final JSON line before exiting ${String(code)} on ${signal}`, async () => {
			for (let run = 0; run < 2; run++) {
				response = `${"x".repeat(PADDING)} ${TAIL}`;
				const child = start();
				const output: string[] = [];
				const stderr: string[] = [];
				child.stdout?.on("data", (chunk: string) => output.push(chunk));
				child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
				// Stop consuming stdout while the answer streams, so the child blocks on raw stdout writes.
				child.stdout?.pause();
				const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
					child.once("exit", (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
				});
				await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
				child.kill(signal);
				await new Promise((resolveWait) => setTimeout(resolveWait, 200));
				child.stdout?.resume();
				const ending = await Promise.race([
					exited,
					new Promise<never>((_, rejectWait) =>
						setTimeout(() => rejectWait(new Error(`no exit\n${output.join("")}`)), 20_000),
					),
				]);
				expect(ending, `stdout bytes ${String(output.join("").length)}\nstderr:\n${stderr.join("")}`).toEqual({ code, signal: null });
				const lines = output.join("").split("\n").filter((line) => line.startsWith("{"));
				expect(lines.length).toBeGreaterThan(0);
				for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
				const marked = lines.filter((line) => line.includes(TAIL));
				expect(marked.length).toBeGreaterThan(0);
				// The marker reaches the wire intact, in the last message that carries the answer.
				const last = marked.at(-1)!;
				const parsed = JSON.parse(last) as {
					type: string;
					message?: { content?: { type: string; text?: string }[] };
					messages?: { content?: { type: string; text?: string }[] }[];
					assistantMessageEvent?: { delta?: string; content?: string };
				};
				const textOf = (message: { content?: { type: string; text?: string }[] } | undefined) =>
					message?.content?.find((block) => block.type === "text")?.text;
				const text =
					textOf(parsed.message) ??
					textOf(parsed.messages?.at(-1)) ??
					parsed.assistantMessageEvent?.delta ??
					parsed.assistantMessageEvent?.content ??
					"";
				expect(text.endsWith(TAIL), last.slice(-200)).toBe(true);
			}
		}, 60_000);
	}

	it("exits within bounds when stdout closes early", async () => {
		const child = start();
		const output: string[] = [];
		child.stdout?.on("data", (chunk: string) => output.push(chunk));
		child.stdout?.on("error", () => {});
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));
		child.stdout?.destroy();
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
			child.once("exit", (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
		});
		const ending = await Promise.race([
			exited,
			new Promise<never>((_, rejectWait) => setTimeout(() => rejectWait(new Error("EPIPE waited forever")), 15_000)),
		]);
		expect(ending.signal).toBeNull();
		expect(typeof ending.code).toBe("number");
	}, 30_000);
});
