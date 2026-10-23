import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SHUTDOWN_FORCE_EXIT_MESSAGE } from "../src/utils/shutdown-signals.ts";
import { createTempDir } from "./temp-dir.ts";

const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/source-resolver.ts")).href;
const cliPath = resolve(__dirname, "../src/cli.ts");
const tmuxSocket = `am-screen-${process.pid}`;

describe.skipIf(process.platform === "win32" || !tmuxAvailable())("durable TUI screen restore", () => {
	const directories: string[] = [];
	let server: Server | undefined;

	afterEach(async () => {
		tmux(["kill-server"]);
		await new Promise<void>((resolveClose) => {
			if (server === undefined) {
				resolveClose();
				return;
			}
			server.close(() => resolveClose());
			server = undefined;
		});
		await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
		directories.length = 0;
	});

	it("returns to a clean shell prompt after /quit", async () => {
		const pane = await runExit({
			send: (session) => tmux(["send-keys", "-t", session, "/quit", "Enter"]),
			marker: "CLEAN_EXIT_0",
		});
		expect(pane).toContain("CLEAN_EXIT_0");
		expect(pane).not.toContain("AmazMe v");
		expect(pane).not.toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	}, 45_000);

	it("returns to a clean shell prompt after one Ctrl-C", async () => {
		const pane = await runExit({
			send: (session) => tmux(["send-keys", "-t", session, "C-c"]),
			marker: "CLEAN_EXIT_0",
		});
		expect(pane).toContain("CLEAN_EXIT_0");
		expect(pane).not.toContain("AmazMe v");
		expect(pane).not.toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	}, 45_000);

	it("force-exits within 1s when two Ctrl-C arrive together, with the message on its own line", async () => {
		const { pane, elapsedMs } = await runExitTimed({
			send: (session) => tmux(["send-keys", "-H", "-t", session, "03", "03"]),
			marker: "CLEAN_EXIT_130",
			timeoutMs: 5_000,
		});
		expect(elapsedMs).toBeLessThan(1_000);
		expect(pane).toContain("CLEAN_EXIT_130");
		expect(pane).not.toContain("AmazMe v");
		const messageLine = pane.split("\n").find((line) => line.includes("Forced exit."));
		expect(messageLine?.startsWith("Forced exit.")).toBe(true);
		expect(messageLine).not.toMatch(/[│╭>]/);
	}, 45_000);

	it("keeps the regular-mode conversation on screen after /quit", async () => {
		const pane = await runExit({
			send: (session) => tmux(["send-keys", "-t", session, "/quit", "Enter"]),
			marker: "CLEAN_EXIT_0",
			tuiMode: "regular",
		});
		expect(pane).toContain("CLEAN_EXIT_0");
		expect(pane).toContain("AmazMe v");
		expect(pane).not.toContain(SHUTDOWN_FORCE_EXIT_MESSAGE);
	}, 45_000);

	async function runExit(options: {
		readonly send: (session: string) => SpawnSyncReturns<string>;
		readonly marker: string;
		readonly tuiMode?: "regular" | "fullscreen";
		readonly timeoutMs?: number;
	}): Promise<string> {
		return (await runExitTimed(options)).pane;
	}

	async function runExitTimed(options: {
		readonly send: (session: string) => SpawnSyncReturns<string>;
		readonly marker: string;
		readonly tuiMode?: "regular" | "fullscreen";
		readonly timeoutMs?: number;
	}): Promise<{ pane: string; elapsedMs: number }> {
		server = createServer((_request, response) => {
			response.writeHead(500);
			response.end("model request was not expected");
		});
		await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("test server did not bind");
		const port = (address as AddressInfo).port;

		const directory = createTempDir("am-screen-");
		directories.push(directory);
		const cwd = join(directory, "project");
		const profile = join(directory, "profile");
		const sessionDir = join(directory, "sessions");
		await mkdir(cwd);
		await mkdir(profile);
		await writeFile(
			join(profile, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "test-key",
						models: [
							{
								id: "plain",
								name: "Fixture",
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
		const script = join(directory, "run.sh");
		const modeArg = options.tuiMode === undefined ? "" : ` --tui-mode ${options.tuiMode}`;
		await writeFile(
			script,
			[
				"#!/bin/sh",
				`cd ${quote(cwd)}`,
				"export TERM=xterm-256color",
				"export COLUMNS=80",
				"export LINES=24",
				`export AMAZME_CODING_AGENT_DIR=${quote(profile)}`,
				"export AMAZME_DURABLE_TUI=1",
				"export AMAZME_OFFLINE=1",
				`${quote(process.execPath)} --experimental-strip-types --import ${quote(sourceResolverUrl)} ${quote(cliPath)} --offline --provider fixture --model plain --api-key test-key --session-dir ${quote(sessionDir)} --no-extensions --no-mcp${modeArg}`,
				"status=$?",
				"echo CLEAN_EXIT_$status",
				"sleep 30",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);

		const session = "screen";
		const created = tmux([
			"new-session",
			"-d",
			"-s",
			session,
			"-x",
			"80",
			"-y",
			"24",
			"-c",
			cwd,
			"sh",
			script,
		]);
		expect(created.status, created.stderr).toBe(0);
		tmux(["set-option", "-t", session, "remain-on-exit", "on"]);
		await waitForPane(session, (text) => text.includes("AmazMe v"), "startup banner");
		const sentAt = Date.now();
		const sent = options.send(session);
		expect(sent.status, sent.stderr).toBe(0);
		await waitForPane(session, (text) => text.includes(options.marker), options.marker, options.timeoutMs ?? 20_000);
		return { pane: capture(session), elapsedMs: Date.now() - sentAt };
	}
});

function tmuxAvailable(): boolean {
	const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	return result.status === 0;
}

function tmux(args: readonly string[]): SpawnSyncReturns<string> {
	return spawnSync("tmux", ["-L", tmuxSocket, ...args], { encoding: "utf8" });
}

function capture(session: string): string {
	const result = tmux(["capture-pane", "-t", session, "-p", "-S", "-300"]);
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout;
}

async function waitForPane(
	session: string,
	ready: (text: string) => boolean,
	label: string,
	timeoutMs = 20_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		last = capture(session);
		if (ready(last)) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 30));
	}
	throw new Error(`did not reach ${label}\n${last}`);
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
