import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { afterEach, expect, test } from "vitest";
import { ExecutionEnvs } from "../src/host/session-registry.ts";
import { loadPythonSessionModel, savePythonSessionModel } from "../src/host/python-session-model.ts";
import { createTempDir } from "./temp-dir.ts";

const children: ChildProcess[] = [];

afterEach(() => {
	delete process.env.AMAZME_PYTHON_URL;
	delete process.env.AMAZME_PYTHON_TOKEN;
	delete process.env.AMAZME_PYTHON_SESSION;
	for (const child of children) child.kill();
	children.length = 0;
});

async function startPython(): Promise<{ url: string; token: string; profile: string }> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const directory = createTempDir("amazme-owned-host-");
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
	children.push(serve);
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
	return { url, token, profile };
}

test("the test host stores the selected model on the Python host", async () => {
	const started = await startPython();
	await savePythonSessionModel("demo-1", { provider: "anthropic", model: "claude-opus-4-6" });
	await savePythonSessionModel("demo-2", { provider: "anthropic", model: "claude-sonnet-4-5" });
	expect(await loadPythonSessionModel("demo-1")).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
	expect(await loadPythonSessionModel("demo-2")).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
	const stop = spawn(join(fileURLToPath(new URL("../../..", import.meta.url)), "backend/.venv/bin/python"),
		["-m", "amazme_backend", "stop", "--profile", started.profile],
		{ cwd: fileURLToPath(new URL("../../..", import.meta.url)) });
	await new Promise<void>((resolve) => stop.on("exit", () => resolve()));
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
	const result = await env.exec("echo amazme-python-terminal", undefined, BACKGROUND_CONTEXT);
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.message).toMatch(/pty_|terminal|container|docker|supervisor|vm_/);
});
