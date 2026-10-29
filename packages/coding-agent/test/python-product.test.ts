import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { main, requestOptions } from "../src/main.ts";
import { parseArgs } from "../src/cli/args.ts";
import { HostClient } from "../src/client/host-client.ts";
import { runPythonProductCommand } from "../src/python-product.ts";
import { connectPythonHost } from "../src/connection/connection.ts";
import { runPythonSessionTui } from "../src/modes/interactive/session.ts";

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
vi.mock("../src/connection/connection.ts", () => ({
	connectPythonHost: vi.fn(async () => ({
		url: "http://127.0.0.1:1234",
		token: "web-token",
	})),
}));
vi.mock("../src/modes/interactive/session.ts", () => ({
	runPythonSessionTui: vi.fn(async () => {}),
	runOwnedPythonInteractive: vi.fn(async () => {}),
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

test("web prints a bound session URL and server prints the listener without the token", async () => {
	vi.spyOn(HostClient.prototype, "bootstrap").mockResolvedValue();
	vi.spyOn(HostClient.prototype, "selectWorkspace").mockResolvedValue("project");
	const windowUrl = vi.spyOn(HostClient.prototype, "windowUrl").mockResolvedValue("http://127.0.0.1:1234/?host=profile&session=one&workspace=project");
	const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	await runPythonProductCommand(["web", "--port", "0"], "/project");
	await runPythonProductCommand(["server"], "/project");
	expect(write.mock.calls.flat().join("")).toBe(
		"http://127.0.0.1:1234/?host=profile&session=one&workspace=project\nhttp://127.0.0.1:1234/\n",
	);
	expect(windowUrl).toHaveBeenCalledWith("project");
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
    await main(["--python-url", "http://target", "--python-token", "private", `@${textPath}`, `@${imagePath}`, "-e", "./tools/helper.py", "--theme", "./colors.json", "--no-themes", "--verbose", "first", "second"]);
    expect(runPythonSessionTui).toHaveBeenCalledOnce();
    expect(runPythonSessionTui).toHaveBeenCalledWith(expect.objectContaining({
        url:"http://target", token:"private", workspace:"primary", prompt:expect.stringContaining("file content"),
        extensions:[join(process.cwd(), "tools/helper.py")], themes:[join(process.cwd(), "colors.json")], noThemes:true, verbose:true,
        images:[expect.objectContaining({type:"image",mimeType:"image/png"})],
    }));
    expect(vi.mocked(runPythonSessionTui).mock.calls[0]?.[0].prompt).toContain("first\nsecond");
});


test("thinking selection reaches the Python request options", () => {
    expect(requestOptions(parseArgs(["--thinking", "max"]))).toEqual({thinking:"max"});
    expect(requestOptions(parseArgs(["--thinking", "off"]))).toEqual({thinking:"off"});
});


test("explicit Python extensions bind their launch directory and no-extensions disables unselected plugin tools", () => {
    expect(requestOptions(parseArgs(["--no-extensions"]))).toEqual({excluded_tools:["plugin_*"]});
    expect(requestOptions(parseArgs(["--no-extensions", "-e", "./tool.py"]))).toEqual({});
});


test("custom history selects the same Python profile for product model configuration", async () => {
    await runPythonProductCommand(["models"], "/project", {sessionDir:"/history"});
    expect(connectPythonHost).toHaveBeenCalledWith({cwd:"/project", sessionDir:"/history"});
    await expect(main(["--session-dir", "/history", "--no-session", "hello"])).rejects.toThrow("session_dir_requires_local_persistent_host");
    await expect(main(["--session-dir", "/history", "--python-url", "http://target", "--python-token", "token", "hello"])).rejects.toThrow("session_dir_requires_local_persistent_host");
});


test("an unpinned request decision is rejected before connecting to a host", async () => {
    await expect(main(["--session", "a".repeat(32), "--decision", "批准", "--request", "original"])).rejects.toThrow("approval_id_required");
    expect(connectPythonHost).not.toHaveBeenCalled();
    expect(parseArgs(["--approval-id", "reviewed"]).approvalId).toBe("reviewed");
});


test("retired TS options fail before any host mutation and offline sets the original metadata flags", async () => {
    await expect(main(["--export", "old.jsonl"])).rejects.toThrow("export --output PATH");
    await expect(main(["--approve"])).rejects.toThrow("原提案编号");
    expect(connectPythonHost).not.toHaveBeenCalled();
    vi.stubEnv("AMAZME_OFFLINE", "");
    vi.stubEnv("AMAZME_SKIP_VERSION_CHECK", "");
    vi.spyOn(process.stdout,"write").mockReturnValue(true);
    await main(["--offline", "--help"]);
    expect(process.env.AMAZME_OFFLINE).toBe("1");
    expect(process.env.AMAZME_SKIP_VERSION_CHECK).toBe("1");
});

test("mcp add-kimi-cu checks platform and executable binary before opening a Python host", async () => {
	const directory = createTempDir("amazme-kimi-cu-");
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const fakeBin = join(directory, "kimi-cu");
	writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
	chmodSync(fakeBin, 0o755);
	const out: string[] = [];
	const err: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		out.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		err.push(String(chunk));
		return true;
	});

	expect(
		await runPythonProductCommand(["mcp", "add-kimi-cu"], "/project", {
			platform: "darwin",
			kimiCuBinary: join(directory, "missing-kimi-cu"),
		}),
	).toBe(true);
	expect(process.exitCode).toBe(1);
	expect(out.join("")).toBe(
		"curl -fsSL https://cdn.kimi.com/kimi-computer-use/latest/setup_macos.sh | bash\n",
	);
	expect(err.join("")).toBe("");
	expect(connectPythonHost).not.toHaveBeenCalled();
	expect(spawn).not.toHaveBeenCalled();

	out.length = 0;
	err.length = 0;
	process.exitCode = 0;
	expect(
		await runPythonProductCommand(["mcp", "add-kimi-cu"], "/project", {
			platform: "linux",
			kimiCuBinary: fakeBin,
		}),
	).toBe(true);
	expect(process.exitCode).toBe(1);
	expect(out.join("")).toBe("");
	expect(err.join("")).toBe("unsupported_platform\n");
	expect(connectPythonHost).not.toHaveBeenCalled();
	expect(spawn).not.toHaveBeenCalled();

	out.length = 0;
	err.length = 0;
	process.exitCode = 0;
	vi.stubEnv("AMAZME_PYTHON_BACKEND", "/local/amazme-backend");
	expect(
		await runPythonProductCommand(["mcp", "add-kimi-cu"], "/project", {
			platform: "darwin",
			kimiCuBinary: fakeBin,
		}),
	).toBe(true);
	expect(process.exitCode).toBe(0);
	expect(connectPythonHost).toHaveBeenCalledWith({ cwd: "/project" });
	expect(spawn).toHaveBeenCalledWith(
		"/local/amazme-backend",
		[
			"client",
			"--url",
			"http://127.0.0.1:1234",
			"--token",
			"web-token",
			"mcp",
			"add-kimi-cu",
		],
		{ cwd: "/project", stdio: ["inherit", "inherit", "inherit"] },
	);
});
