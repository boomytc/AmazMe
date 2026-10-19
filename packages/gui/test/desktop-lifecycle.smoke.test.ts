import { createServerServiceSource } from "../../coding-agent/src/host/services/connection.ts";
import { SessionManagement } from "../../coding-agent/src/host/services/sessions.ts";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { type ChildProcess, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@amazme/coding-agent/client";
import { describe, expect, test } from "vitest";
import { createWebSocketTransportFactory } from "../../client/src/websocket.ts";
import { resolveHostCli } from "../src/launch.ts";
import { alive, electronBinary, processRows, processTree, smokeEnvironment, waitFor, type ProcessRow } from "./smoke-support.ts";
import { createTempDir } from "./temp-dir.ts";

const ownedTrees = new WeakMap<ChildProcess, ProcessRow[]>();
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
function capture(child: ChildProcess) {
	let output = "";
	let exited = false;
	let exit: { code: number | null; signal: string | null } | undefined;
	child.stdout?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32_000); });
	child.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32_000); });
	child.once("exit", (code, signal) => { exited = true; exit = { code, signal }; });
	child.once("error", (error) => { output += error.message; exited = true; });
	return { output: () => output, exited: () => exited, exit: () => exit };
}
async function desktop(scratch: string) {
	const child = spawn(electronBinary(), ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "."], {
		cwd: packageRoot, detached: true, stdio: ["ignore", "pipe", "pipe"],
		env: { ...smokeEnvironment(scratch), AMAZME_GUI_SMOKE_HOLD: "1", __AMAZME_SESSION_WORKER_ORPHAN_DEMAND_GRACE_MS: "100" },
	});
	const state = capture(child);
	try {
		await waitFor(() => /^desktop smoke: /mu.test(state.output()), state.output, 150_000);
		const url = /^desktop smoke: (\S+) /mu.exec(state.output())?.[1];
		const pid = child.pid;
		if (!url || pid === undefined) throw new Error(state.output());
		const tree = processTree(await processRows(), pid);
		const hostPid = Number(/^desktop host pid: (\d+)/mu.exec(state.output())?.[1]);
		const host = tree.find((row) => row.pid === hostPid && row.ppid === pid);
		if (!host) throw new Error(`owned host PID missing: ${JSON.stringify(tree)}`);
		ownedTrees.set(child, tree);
		return { child, state, pid, url, host, tree };
	} catch (error) { await cleanupOwned(child); throw error; }
}
async function cleanupOwned(child: ChildProcess | undefined): Promise<void> {
	if (child?.pid === undefined) return;
	const seen = [...(ownedTrees.get(child) ?? []), ...processTree(await processRows(), child.pid)];
	const tree = [...new Map(seen.map((row) => [row.pid, row])).values()];
	if (alive(child.pid)) child.kill("SIGKILL");
	try {
		await waitFor(() => tree.every((row) => !alive(row.pid)), () => "cleanup grace elapsed", 5_000);
	} catch {
		// Failure cleanup is limited to exact PIDs/commands recorded from this isolated launch.
		const current = await processRows();
		for (const row of tree) {
			if (!current.some((candidate) => candidate.pid === row.pid && candidate.command === row.command)) continue;
			try { process.kill(row.pid, "SIGKILL"); } catch { /* Already reaped. */ }
		}
		await waitFor(() => tree.every((row) => !alive(row.pid)), () => `owned processes remain: ${JSON.stringify(tree)}`);
	}
}
async function attachFixtureWorker(running: Awaited<ReturnType<typeof desktop>>, options: { url?: string; parentPid?: number } = {}): Promise<{ client: Client; worker: ProcessRow }> {
	const marker = /^desktop smoke: \S+ (\{[^\n]+\})/mu.exec(running.state.output())?.[1];
	const report: unknown = JSON.parse(marker ?? "null");
	if (typeof report !== "object" || report === null || !("serverId" in report) || typeof report.serverId !== "string") throw new Error("Missing smoke server id");
	const previous = new Set((await processRows()).map((row) => row.pid));
	const client = await Client.connect({ serverId: report.serverId, transportFactory: createWebSocketTransportFactory({ url: (options.url ?? running.url).replace(/^http/u, "ws") + "amazme" }) });
	try {
		const source = createServerServiceSource(client);
  const binding = source.open({ services: [SessionManagement], assertAccess() {}, onError(error) { throw error; } });
  try {
   await binding.ready(BACKGROUND_CONTEXT);
   const sessions = binding.get(SessionManagement);
   await sessions.create({ id: "desktop-fixture" }, BACKGROUND_CONTEXT);
   await sessions.attach("desktop-fixture", BACKGROUND_CONTEXT);
  } finally { await source.dispose(BACKGROUND_CONTEXT); }
		const rows = await processRows();
		const tree = processTree(rows, running.pid);
		const workers = rows.filter((row) => row.ppid === (options.parentPid ?? running.host.pid) && !previous.has(row.pid));
		expect(workers).toHaveLength(1);
		const worker = workers[0];
		if (!worker) throw new Error("Fixture worker PID missing");
		running.tree = tree;
		ownedTrees.set(running.child, tree);
		return { client, worker };
	} catch (error) { await client.dispose(); throw error; }
}
function processEvidence(tree: readonly ProcessRow[]) {
	return tree.map(({ pid, ppid, command }) => ({ pid, ppid, command: command.slice(0, 140) }));
}

describe.skipIf(process.platform === "win32")("real Electron owned-process lifecycle (POSIX)", () => {
	test.each(["SIGTERM", "SIGKILL"] as const)("parent %s releases its owned host port and idle worker", async (signal) => {
		const scratch = createTempDir("amazme-desktop-parent-");
		let child: ChildProcess | undefined;
		let client: Client | undefined;
		try {
			const running = await desktop(scratch);
			child = running.child;
			expect((await fetch(running.url)).status).toBe(200);
			const attached = await attachFixtureWorker(running);
			client = attached.client;
			child.kill(signal);
			await waitFor(() => running.tree.every((row) => !alive(row.pid)), () => `${JSON.stringify(running.tree)}\n${running.state.output()}`);
			await expect(fetch(running.url)).rejects.toThrow();
			console.log(JSON.stringify({ scenario: `electron-${signal}`, workerPid: attached.worker.pid, url: running.url, processes: processEvidence(running.tree), exit: running.state.exit(), portReleased: true }));
		} finally { await client?.dispose(); await cleanupOwned(child); await rm(scratch, { recursive: true, force: true }); }
	}, 180_000);

	test("host SIGKILL releases its port, closes the shell and retires its idle worker", async () => {
		const scratch = createTempDir("amazme-desktop-host-");
		let child: ChildProcess | undefined;
		let client: Client | undefined;
		try {
			const running = await desktop(scratch);
			child = running.child;
			const attached = await attachFixtureWorker(running);
			client = attached.client;
			process.kill(running.host.pid, "SIGKILL");
			await waitFor(() => running.tree.every((row) => !alive(row.pid)), () => `${JSON.stringify(running.tree)}\n${running.state.output()}`);
			await expect(fetch(running.url)).rejects.toThrow();
			console.log(JSON.stringify({ scenario: "host-SIGKILL", workerPid: attached.worker.pid, url: running.url, processes: processEvidence(running.tree), exit: running.state.exit(), portReleased: true }));
		} finally { await client?.dispose(); await cleanupOwned(child); await rm(scratch, { recursive: true, force: true }); }
	}, 180_000);

	test("a killed desktop bridge does not kill an existing shared backend", async () => {
		const scratch = createTempDir("amazme-desktop-shared-");
		let child: ChildProcess | undefined;
		let external: ChildProcess | undefined;
		let client: Client | undefined;
		try {
			external = spawn(process.execPath, [resolveHostCli(), "web", "--port", "0"], { cwd: scratch, env: smokeEnvironment(scratch), stdio: ["ignore", "pipe", "pipe"] });
			const outside = capture(external);
			await waitFor(() => /^Web: /mu.test(outside.output()), outside.output, 120_000);
			const externalUrl = /^Web: (\S+)/mu.exec(outside.output())?.[1];
			if (!externalUrl) throw new Error(outside.output());
			const running = await desktop(scratch);
			child = running.child;
			expect(running.url).not.toBe(externalUrl);
			const attached = await attachFixtureWorker(running, { url: externalUrl, parentPid: external.pid });
			client = attached.client;
			child.kill("SIGKILL");
			await waitFor(() => running.tree.every((row) => !alive(row.pid)), () => JSON.stringify(running.tree));
			expect(outside.exited()).toBe(false);
			expect(alive(attached.worker.pid)).toBe(true);
			expect((await fetch(externalUrl)).status).toBe(200);
			await expect(fetch(running.url)).rejects.toThrow();
			console.log(JSON.stringify({ scenario: "shared-backend", externalPid: external.pid, sharedWorkerPid: attached.worker.pid, externalUrl, processes: processEvidence(running.tree), sharedAlive: true }));
		} finally {
			await client?.dispose();
			await cleanupOwned(child);
			if (external?.pid !== undefined && alive(external.pid)) {
				const state = capture(external);
				external.kill("SIGTERM");
				await waitFor(state.exited, state.output);
			}
			await rm(scratch, { recursive: true, force: true });
		}
	}, 180_000);
});
