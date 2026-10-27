import { expect, onTestFinished, test, vi } from "vitest";
import { rmSync } from "node:fs";
import { createTempDir } from "./temp-dir.ts";
import { runPythonSessionTui } from "../src/modes/interactive/session.ts";

const screen = vi.hoisted(() => ({
	rendered: new Array<string>(),
	editor: null as null | {
		onSubmit?: (text: string) => void;
		onBeforeInput?: (text: string) => boolean;
	},
}));
vi.mock("../src/modes/interactive/tui-renderer.ts", () => ({
	createInteractiveTui: () => {
		screen.rendered = [];
		let child: { render(width: number): string[] } | undefined;
		return {
			stop() {},
			start() {},
			addChild(component: { render(width: number): string[] }) { child = component; },
			setFocus() {},
			requestRender() { screen.rendered = child?.render(120) ?? []; },
		};
	},
}));
vi.mock("../src/modes/interactive/components/custom-editor.ts", () => ({
	CustomEditor: class {
		constructor() {
			screen.editor = this;
		}
		onSubmit?: (text: string) => void;
		onBeforeInput?: (text: string) => boolean;
		setText() {}
		render() { return []; }
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

test.each(["批准", "拒绝"])("prompts entered before and during an approval drain in order after %s", async (decision) => {
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
	const session = "a".repeat(32);
	const submissions: Array<Record<string, unknown>> = [];
	let resolveFirst: ((value: Response) => void) | undefined;
	let decided = false,
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
					resolveFirst && !decided
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
			expect(JSON.parse(String(init?.body))).toMatchObject({ approve: decision === "批准" });
			decided = true;
			return reply({});
		}
		if (url.includes("/requests/")) {
			const id = url.slice(url.lastIndexOf("/") + 1);
			if (id === submissions[0]?.request_id && !decided)
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
	await until(() => screen.rendered.some((line) => line.startsWith("等待审批")));
	expect(submissions.map((body) => body.text)).toEqual(["first"]);
	expect(submissions[0]?.images).toEqual([{ media_type: "image/png", data_base64: "aW1hZ2U=" }]);
	screen.editor?.onSubmit?.("fourth");
	expect(screen.rendered).toContain("已排队 3 条");
	screen.editor?.onSubmit?.(decision);
	await until(() => submissions.length === 4);
	expect(submissions.map((body) => body.text)).toEqual(["first", "second", "third", "fourth"]);
	expect(submissions[1]?.images).toEqual([]);
	screen.editor?.onBeforeInput?.("\x03");
	await run;
	expect(ended).toBeUndefined();
	expect(deleted).toBe(true);
});

test("a decision typed while a submission is finishing drains into the approval it produces", async () => {
	const directory = createTempDir("amazme-tui-queued-decision-");
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
	const session = "b".repeat(32);
	const submissions: Array<Record<string, unknown>> = [];
	const events: string[] = [];
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
					resolveFirst && approved
						? []
						: [
								{
									request_id: submissions[0]?.request_id,
									approval_id: "proposal",
									revision: "1",
									proposal_digest: "digest",
									state: "pending",
									call: { name: "shell", arguments: '{"command":"echo reviewed"}' },
								},
							],
			});
		if (url.endsWith("/submissions")) {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			submissions.push(body);
			events.push(`submit:${String(body.text)}`);
			return reply({});
		}
		if (url.endsWith("/approvals")) {
			approved = true;
			events.push("approval");
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
	const run = runPythonSessionTui({ url: "http://host", token: "token", workspace: "primary", session, prompt: "first" });
	runtime = run.catch(() => {});
	await until(() => Boolean(resolveFirst));
	screen.editor?.onSubmit?.("批准");
	screen.editor?.onSubmit?.("second");
	resolveFirst?.(reply({ request_id: submissions[0]?.request_id, status: "waiting_approval" }));
	await until(() => approved && submissions.length === 2);
	expect(events).toEqual(["submit:first", "approval", "submit:second"]);
	screen.editor?.onBeforeInput?.("\x03");
	await run;
	expect(deleted).toBe(true);
});
