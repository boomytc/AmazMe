import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { main } from "../src/main.ts";
import { HostClient } from "../src/python-headless.ts";
import { runPythonProductCommand } from "../src/python-product.ts";
import { connectPythonHost } from "../src/python-session-tui.ts";

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
