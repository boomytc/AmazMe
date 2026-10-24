import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { main, requestOptions } from "../src/main.ts";
import { parseArgs } from "../src/cli/args.ts";
import { HostClient } from "../src/python-headless.ts";
import { runPythonProductCommand } from "../src/python-product.ts";
import { connectPythonHost, runPythonSessionTui } from "../src/python-session-tui.ts";

import { createTempDir } from "./temp-dir.ts";

const state = vi.hoisted(() => {
	const input: string[] = [];
	return { input };
});
vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		const child = Object.assign(new EventEmitter(), {
			stdin: { end: (value: string) => state.input.push(value) },
			kill: vi.fn(),
		});
		queueMicrotask(() => child.emit("exit", 0, null));
		return child;
	}),
	spawnSync: vi.fn(),
}));
vi.mock("../src/python-session-tui.ts", () => ({
    runPythonSessionTui: vi.fn(async () => {}),
    runOwnedPythonInteractive: vi.fn(async () => {}),
	connectPythonHost: vi.fn(async () => ({
		url: "http://127.0.0.1:1234",
		token: "web-token",
	})),
}));

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	state.input.length = 0;
	process.exitCode = 0;
});

test.each(["models", "accounts", "auth", "import", "export", "doctor"])(
	"%s uses Python client without opening a TS runtime",
	async (command) => {
		vi.stubEnv("AMAZME_PYTHON_BACKEND", "/local/amazme-backend");
		expect(
			await runPythonProductCommand(
				[command, "--python-url", "http://target", "--python-token", "private"],
				"/project",
			),
		).toBe(true);
		expect(connectPythonHost).toHaveBeenCalledWith({
			cwd: "/project",
			url: "http://target",
			token: "private",
		});
		expect(spawn).toHaveBeenCalledWith(
			"/local/amazme-backend",
			[
				"client",
				"--url",
				"http://127.0.0.1:1234",
				"--token",
				"web-token",
				command,
			],
			{ cwd: "/project", stdio: ["inherit", "inherit", "inherit"] },
		);
	},
);

test("web and server print the Python listener without printing its token", async () => {
	const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	await runPythonProductCommand(["web", "--port", "0"], "/project");
	await runPythonProductCommand(["server"], "/project");
	expect(write.mock.calls.flat().join("")).toBe(
		"http://127.0.0.1:1234/\nhttp://127.0.0.1:1234/\n",
	);
	expect(spawn).not.toHaveBeenCalled();
});

test("invalid targets and server options fail before host creation", async () => {
	await expect(
		runPythonProductCommand(
			["models", "--python-url", "http://target"],
			"/project",
		),
	).rejects.toThrow("python_target_required");
	await expect(
		runPythonProductCommand(["server", "--server-id", "old"], "/project"),
	).rejects.toThrow("usage:");
	expect(connectPythonHost).not.toHaveBeenCalled();
});

test("a typed key is sent on stdin, without a credential in the child argv", async () => {
	await runPythonProductCommand(
		["auth", "login", "--provider", "deepseek", "--method", "api-key"],
		"/project",
		{ input: "typed-private-key", quiet: true },
	);
	expect(state.input).toEqual(["typed-private-key\n"]);
	expect(JSON.stringify(vi.mocked(spawn).mock.calls)).not.toContain(
		"typed-private-key",
	);
});

test("invalid session IDs are rejected before opening the Python profile", async () => {
	await expect(
		main(["--session", "legacy.jsonl", "--print", "hello"]),
	).rejects.toThrow("invalid_session");
	expect(connectPythonHost).not.toHaveBeenCalled();
});

test("headless image input reaches the Python submission with its original bytes", async () => {
	const sent: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options: RequestInit = {}) => {
			if (url.endsWith("/bootstrap"))
				return new Response(
					JSON.stringify({ build_id: "build", host_epoch: 1 }),
				);
			if (url.endsWith("/sessions"))
				return new Response(
					JSON.stringify({
						sessions: [{ session_id: "session", workspace: "primary" }],
					}),
				);
			if (url.endsWith("/submissions")) {
				sent.push(String(options.body));
				return new Response(
					JSON.stringify({ request_id: "request", status: "queued" }),
				);
			}
			return new Response(
				JSON.stringify({
					request_id: "request",
					status: "succeeded",
					answer: "看到了",
				}),
			);
		}),
	);
	const client = new HostClient("http://127.0.0.1:1234", "token");
	await client.bootstrap();
	await client.submit("session", "primary", "attachment", "看看图片🙂", [
		{ type: "image", mimeType: "image/png", data: "original-base64" },
	]);
	expect(sent).toHaveLength(1);
	expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
		text: "看看图片🙂",
		images: [{ media_type: "image/png", data_base64: "original-base64" }],
	});
});

test("CLI tool selectors and prompts use native per-run options", async () => {
	const { parseArgs } = await import("../src/cli/args.ts");
	expect(
		requestOptions(
			parseArgs([
				"--system-prompt",
				"custom",
				"--append-system-prompt",
				"one",
				"--append-system-prompt",
				"two",
				"--tools",
				"read_file,shell",
				"--exclude-tools",
				"shell",
			]),
		),
	).toEqual({
		system_prompt: "custom",
		append_system_prompt: "one\n\ntwo",
		allowed_tools: ["read_file", "shell"],
		excluded_tools: ["shell"],
	});
	expect(requestOptions(parseArgs(["--no-tools"]))).toEqual({
		allowed_tools: [],
	});
	expect(requestOptions(parseArgs(["--no-builtin-tools"]))).toEqual({
		allowed_tools: ["mcp_*", "plugin_*"],
	});
	expect(
		requestOptions(parseArgs(["--no-mcp", "--tools", "+shell,-write_file"])),
	).toEqual({
		allowed_tools: ["*", "shell"],
		excluded_tools: ["write_file", "mcp_*"],
	});
	expect(parseArgs(["--tools", "read_file,+shell"]).diagnostics).toHaveLength(
		1,
	);
});

test("HTTP and RPC submissions carry the same immutable run defaults", async () => {
	const sent: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/bootstrap"))
				return new Response(
					JSON.stringify({ build_id: "build", host_epoch: 1 }),
				);
			if (url.endsWith("/sessions"))
				return new Response(
					JSON.stringify({
						sessions: [{ session_id: "s", workspace: "primary" }],
					}),
				);
			if (url.includes("/requests/"))
				return new Response(JSON.stringify({ status: "succeeded" }));
			sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response("{}");
		}),
	);
	const client = new HostClient("http://target", "token", {
		system_prompt: "bound",
		allowed_tools: [],
	});
	await client.bootstrap();
	await client.submit("s", "primary", "a", "hello");
	await client.rpc({
		method: "request.submit",
		params: { text: "rpc", system_prompt: "explicit" },
	});
	expect(sent[0]).toMatchObject({
		system_prompt: "bound",
		allowed_tools: [],
		text: "hello",
	});
	expect(sent[1]).toMatchObject({
		params: { system_prompt: "explicit", allowed_tools: [], text: "rpc" },
	});
});


test("resource options reach Python without client-side discovery or expansion", async () => {
    const options = requestOptions(parseArgs(["--no-context-files", "--no-skills", "--skill", "/explicit/skills",
        "--no-prompt-templates", "--prompt-template", "/explicit/template.md"]));
    expect(options.resource_options).toEqual({no_context_files:true,no_skills:true,skill_paths:["/explicit/skills"],
        no_prompt_templates:true,prompt_paths:["/explicit/template.md"]});
});


test("interactive CLI carries the initial text, file and image into the Python TUI", async () => {
    const directory = createTempDir("amazme-initial-input-");
    onTestFinished(() => rmSync(directory, {recursive:true,force:true}));
    const textPath = join(directory, "note.txt"), imagePath = join(directory, "dot.png");
    writeFileSync(textPath, "file content");
    writeFileSync(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const streams = [process.stdin, process.stdout];
    const previous = streams.map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
    for (const stream of streams) Object.defineProperty(stream, "isTTY", {configurable:true,value:true});
    onTestFinished(() => streams.forEach((stream, index) => {
        const descriptor = previous[index];
        if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
        else Reflect.deleteProperty(stream, "isTTY");
    }));
    await main(["--python-url", "http://target", "--python-token", "private", `@${textPath}`, `@${imagePath}`, "first", "second"]);
    expect(runPythonSessionTui).toHaveBeenCalledOnce();
    expect(runPythonSessionTui).toHaveBeenCalledWith(expect.objectContaining({
        url:"http://target", token:"private", workspace:"primary", prompt:expect.stringContaining("file content"),
        images:[expect.objectContaining({type:"image",mimeType:"image/png"})],
    }));
    expect(vi.mocked(runPythonSessionTui).mock.calls[0]?.[0].prompt).toContain("first\nsecond");
});
