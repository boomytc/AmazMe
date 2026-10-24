import { expect, onTestFinished, test, vi } from "vitest";
import { rmSync } from "node:fs";
import { createTempDir } from "./temp-dir.ts";
import { runPythonSessionTui } from "../src/python-session-tui.ts";

const screen = vi.hoisted(() => ({
	editor: null as null | {
		onSubmit?: (text: string) => void;
		onBeforeInput?: (text: string) => boolean;
	},
}));
vi.mock("../src/modes/interactive/tui-renderer.ts", () => ({
	createInteractiveTui: () => ({ stop() {}, start() {}, addChild() {}, setFocus() {}, requestRender() {} }),
}));
vi.mock("../src/modes/interactive/components/custom-editor.ts", () => ({
	CustomEditor: class {
		constructor() {
			screen.editor = this;
		}
		onSubmit?: (text: string) => void;
		onBeforeInput?: (text: string) => boolean;
		setText() {}
	},
}));

const reply = (body: unknown) => new Response(JSON.stringify(body));
async function until(ready: () => boolean): Promise<void> {
	for (let count = 0; count < 200; count++) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("TUI did not progress");
}

test("initial attachments and consecutive prompts wait for a fresh approval, then drain in order", async () => {
	const directory = createTempDir("amazme-tui-queue-");
	vi.stubEnv("AMAZME_CODING_AGENT_DIR", directory);
	let runtime: Promise<void> | undefined;
	onTestFinished(async () => {
		screen.editor?.onBeforeInput?.("\x03");
		await runtime;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw new Error("test-tui-exit");
	});
	const session = "a".repeat(32);
	const submissions: Array<Record<string, unknown>> = [];
	let resolveFirst: ((value: Response) => void) | undefined;
	let approved = false,
		deleted = false;
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		if (url.endsWith("/bootstrap")) return reply({ build_id: "build", host_epoch: 1 });
		if (url.endsWith("/sessions")) return reply({ sessions: [{ session_id: session, workspace: "primary" }] });
		if (url.endsWith("/attachments")) return reply({ attachment_id: "binding" });
		if (init?.method === "DELETE") {
			deleted = true;
			return reply({});
		}
		if (url.endsWith("/terminals")) return reply({ terminals: [] });
		if (url.endsWith("/mcp")) return reply({ servers: [], calls: [] });
		if (url.endsWith("/snapshot"))
			return reply({
				requests: [],
				approvals:
					resolveFirst && !approved
						? [
								{
									request_id: submissions[0]?.request_id,
									approval_id: "proposal",
									revision: "1",
									proposal_digest: "digest",
									state: "pending",
									call: { name: "shell", arguments: '{"command":"echo reviewed"}' },
								},
							]
						: [],
			});
		if (url.endsWith("/submissions")) {
			submissions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return reply({});
		}
		if (url.endsWith("/approvals")) {
			approved = true;
			return reply({});
		}
		if (url.includes("/requests/")) {
			const id = url.slice(url.lastIndexOf("/") + 1);
			if (id === submissions[0]?.request_id && !approved)
				return new Promise<Response>((resolve) => {
					resolveFirst = resolve;
				});
			return reply({ request_id: id, status: "succeeded", answer: "done" });
		}
		throw new Error(`Unexpected ${url}`);
	});
	let ended: unknown;
	const run = runPythonSessionTui({
		url: "http://host",
		token: "token",
		workspace: "primary",
		session,
		prompt: "first",
		images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
	}).catch((error: unknown) => {
		ended = error;
	});
	runtime = run;
	await until(() => Boolean(resolveFirst));
	screen.editor?.onSubmit?.("second");
	screen.editor?.onSubmit?.("third");
	resolveFirst?.(reply({ request_id: submissions[0]?.request_id, status: "waiting_approval" }));
	await new Promise((resolve) => setTimeout(resolve, 15));
	expect(submissions.map((body) => body.text)).toEqual(["first"]);
	expect(submissions[0]?.images).toEqual([{ media_type: "image/png", data_base64: "aW1hZ2U=" }]);
	screen.editor?.onSubmit?.("批准");
	await until(() => submissions.length === 3);
	expect(submissions.map((body) => body.text)).toEqual(["first", "second", "third"]);
	expect(submissions[1]?.images).toEqual([]);
	screen.editor?.onBeforeInput?.("\x03");
	await run;
	expect(ended).toBeInstanceOf(Error);
	expect(deleted).toBe(true);
});
