import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { ExecutionEnvs } from "../src/host/session-registry.ts";
import { loadPythonSessionModel, savePythonSessionModel } from "../src/host/python-session-model.ts";

afterEach(() => {
	delete process.env.AMAZME_PYTHON_URL;
	delete process.env.AMAZME_PYTHON_TOKEN;
	delete process.env.AMAZME_PYTHON_SESSION;
});

async function startPython(): Promise<{ url: string; token: string; profile: string; workspace: string }> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "amazme-owned-host-"));
	const profile = join(directory, "profile");
	const workspace = join(directory, "workspace");
	await mkdir(workspace);
	const provider = join(directory, "provider.json");
	await writeFile(provider, JSON.stringify({
		provider: "faux", model: "faux", base_url: "", api_key: "", max_tokens: 2048, proxy: "", headers: {},
	}));
	const python = join(root, "backend/.venv/bin/python");
	await new Promise<void>((resolve, reject) => {
		const init = spawn(python, ["-m", "amazme_backend", "init", "--profile", profile, "--workspace", workspace, "--provider-config", provider], { cwd: root });
		init.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`init ${code}`))));
	});
	const serve = spawn(python, ["-m", "amazme_backend", "serve", "--profile", profile, "--port", "0"], { cwd: root });
	onTestFinished(async () => {
		const stop = spawn(python, ["-m", "amazme_backend", "stop", "--profile", profile], {cwd:root});
		await new Promise<void>((resolve, reject) => {
			stop.once("error", reject);
			stop.once("exit", code => code === 0 ? resolve() : reject(new Error(`stop ${code}`)));
		});
		if (serve.exitCode === null) await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(()=>reject(new Error("owned_host_exit_unconfirmed")), 30_000);
			serve.once("exit", () => {clearTimeout(timer); resolve();});
		});
		const proof = spawn(python, ["-c", "from pathlib import Path; import sys; from amazme_backend.contracts import ProcessLease; from amazme_backend.processes import exited; assert all(exited(ProcessLease.model_validate_json(p.read_bytes())) for p in Path(sys.argv[1]).glob('processes/*.lock'))", profile], {cwd:root});
		await new Promise<void>((resolve, reject) => {
			proof.once("error", reject);
			proof.once("exit", code => code === 0 ? resolve() : reject(new Error("owned_process_exit_unconfirmed")));
		});
		await rm(directory, {recursive:true, force:true});
	});
	const url = await new Promise<string>((resolve, reject) => {
		let pending = "";
		const timer = setTimeout(() => reject(new Error("python serve timeout")), 30_000);
		serve.stdout?.setEncoding("utf8");
		serve.stdout?.on("data", (chunk: string) => {
			pending += chunk;
			const line = pending.split("\n").find((item) => item.startsWith("{") && item.includes("\"url\""));
			if (line === undefined) return;
			clearTimeout(timer);
			resolve(String((JSON.parse(line) as { url: string }).url));
		});
	});
	const token = (await readFile(join(profile, "web.token"), "utf8")).trim();
	process.env.AMAZME_PYTHON_URL = url;
	process.env.AMAZME_PYTHON_TOKEN = token;
	return { url, token, profile, workspace };
}

test("the test host stores the selected model on the Python host", async () => {
	const started = await startPython();
	await savePythonSessionModel("demo-1", { provider: "anthropic", model: "claude-opus-4-6" });
	await savePythonSessionModel("demo-2", { provider: "anthropic", model: "claude-sonnet-4-5" });
	expect(await loadPythonSessionModel("demo-1")).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
	expect(await loadPythonSessionModel("demo-2")).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });

});

test("a configured test host sends terminal commands to Python", async () => {
	const started = await startPython();
	const boot = await fetch(`${started.url}/api/v1/bootstrap`, { headers: { authorization: `Bearer ${started.token}` } });
	const identity = await boot.json() as { build_id: string; host_epoch: number };
	const session = await fetch(`${started.url}/api/v1/sessions`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${started.token}`,
			"content-type": "application/json",
			"x-amazme-build": identity.build_id,
			"x-amazme-epoch": String(identity.host_epoch),
		},
		body: JSON.stringify({ title: "终端" }),
	});
	expect(session.status).toBe(201);
	process.env.AMAZME_PYTHON_SESSION = String((await session.json() as { session_id: string }).session_id);
	const env = new ExecutionEnvs("/tmp", "/tmp/amazme-python-terminal-artifacts").env({});
	const result = await env.exec("printf amazme-python-terminal > execution-proof.txt", undefined, BACKGROUND_CONTEXT);
	expect(result.ok).toBe(true);
	expect(await readFile(join(started.workspace, "execution-proof.txt"), "utf8")).toBe("amazme-python-terminal");
});
