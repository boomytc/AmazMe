/**
 * @vitest-environment happy-dom
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { buildWebView, failureView, windowTitle, type WebViewInput } from "../src/view.ts";

const APP = { name: "AmazMe", version: "1.0.4" };

function input(overrides: Partial<WebViewInput> = {}): WebViewInput {
	return {
		locale: "en",
		submitMode: "followUp",
		attachments: [],
		rosterFilter: "",
		approvals: undefined,
		feedback: undefined,
		showWelcome: false,
		focus: undefined,
		history: [],
		historyMore: false,
		historyLoading: false,
		draft: "",
		commands: [],
		completions: [],
		paletteSelection: 0,
		platform: "",
		dock: {
			open: false,
			tab: "files",
			cwd: "",
			workspace: undefined,
			terminal: undefined,
			conversations: undefined,
		},
		panel: { locale: "en", current: "chat" },
		directory: {
			sessions: [
				{
					sessionId: "alpha-1",
					createdAt: 1,
					cwd: "/w",
					name: "Weekly report",
				},
			],
		},
		transcript: undefined,
		attachedId: "alpha-1",
		now: 0,
		models: undefined,
		thinkingLevels: [],
		...overrides,
	};
}

function titleFromView(view: ReturnType<typeof buildWebView>): string {
	return windowTitle({
		appName: APP.name,
		version: APP.version,
		sessionName: view.sessionLabel,
		pendingCount: view.approvalIndicator?.count ?? 0,
	});
}

beforeAll(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	const body = html.slice(html.indexOf("<body>") + "<body>".length, html.lastIndexOf("</body>"));
	document.body.innerHTML = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

describe("windowTitle", () => {
	test("names the product and version when nothing is attached", () => {
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: undefined, pendingCount: 0 })).toBe(
			"AmazMe 1.0.4",
		);
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: "", pendingCount: 3 })).toBe(
			"AmazMe 1.0.4",
		);
	});

	test("uses the session name, and prefixes a count only while approvals are pending", () => {
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: "Weekly report", pendingCount: 0 })).toBe(
			"Weekly report — AmazMe",
		);
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: "Weekly report", pendingCount: 2 })).toBe(
			"(2) Weekly report — AmazMe",
		);
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: "Plan (draft)", pendingCount: 1 })).toBe(
			"(1) Plan (draft) — AmazMe",
		);
	});

	test("escapes a session name that starts with a count so only pending approvals prefix the title", () => {
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: "(3) x", pendingCount: 0 })).toBe(
			"\uFF083\uFF09 x — AmazMe",
		);
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: "(3) x", pendingCount: 1 })).toBe(
			"(1) \uFF083\uFF09 x — AmazMe",
		);
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: "(03) draft", pendingCount: 0 })).toBe(
			"\uFF0803\uFF09 draft — AmazMe",
		);
		expect(windowTitle({ appName: "AmazMe", version: "1.0.4", sessionName: "Plan (3) x", pendingCount: 0 })).toBe(
			"Plan (3) x — AmazMe",
		);

		const named = buildWebView(
			input({
				directory: { sessions: [{ sessionId: "alpha-1", createdAt: 1, name: "(3) x" }] },
			}),
		);
		expect(named.sessionLabel).toBe("(3) x");
		expect(named.approvalIndicator).toBeUndefined();
		expect(titleFromView(named)).toBe("\uFF083\uFF09 x — AmazMe");
	});

	test("reads the roster display name and the header indicator, including a cleared queue", () => {
		const named = buildWebView(input());
		expect(named.sessionLabel).toBe("Weekly report");
		expect(named.approvalIndicator).toBeUndefined();
		expect(titleFromView(named)).toBe("Weekly report — AmazMe");

		const waiting = buildWebView(
			input({
				approvals: {
					pending: [
						{ id: "a", tool: "bash", detail: "ls" },
						{ id: "b", tool: "write", detail: "notes.md" },
					],
				},
			}),
		);
		expect(waiting.approvalIndicator?.count).toBe(2);
		expect(titleFromView(waiting)).toBe("(2) Weekly report — AmazMe");

		const cleared = buildWebView(input({ approvals: { pending: [] } }));
		expect(cleared.approvalIndicator).toBeUndefined();
		expect(titleFromView(cleared)).toBe("Weekly report — AmazMe");

		const unnamed = buildWebView(
			input({
				directory: { sessions: [{ sessionId: "beta-2", createdAt: 1, name: "   " }] },
				attachedId: "beta-2",
			}),
		);
		expect(unnamed.sessionLabel).toBe("beta-2");
		expect(titleFromView(unnamed)).toBe("beta-2 — AmazMe");

		const detached = buildWebView(input({ attachedId: undefined, directory: undefined }));
		expect(detached.sessionLabel).toBeUndefined();
		expect(titleFromView(detached)).toBe("AmazMe 1.0.4");

		const failed = failureView("en", "cannot boot");
		expect(titleFromView(failed)).toBe("AmazMe 1.0.4");
	});
});

describe("document title on each render", () => {
	test("follows the session name, shows (n) while approvals wait, and drops it when they clear", () => {
		const renderer = createRenderer(collectPageElements(), () => {}, APP);
		renderer.render(buildWebView(input()));
		expect(document.title).toBe("Weekly report — AmazMe");

		renderer.render(
			buildWebView(
				input({
					approvals: { pending: [{ id: "a", tool: "bash", detail: "ls" }] },
				}),
			),
		);
		expect(document.title).toBe("(1) Weekly report — AmazMe");

		renderer.render(
			buildWebView(
				input({
					directory: { sessions: [{ sessionId: "alpha-1", createdAt: 1, name: "Plan (draft)" }] },
					approvals: {
						pending: [
							{ id: "a", tool: "bash", detail: "ls" },
							{ id: "b", tool: "write", detail: "x" },
						],
					},
				}),
			),
		);
		expect(document.title).toBe("(2) Plan (draft) — AmazMe");

		renderer.render(buildWebView(input({ approvals: { pending: [] } })));
		expect(document.title).toBe("Weekly report — AmazMe");

		renderer.render(buildWebView(input({ attachedId: undefined, directory: undefined })));
		expect(document.title).toBe("AmazMe 1.0.4");

		renderer.render(
			buildWebView(
				input({
					directory: { sessions: [{ sessionId: "alpha-1", createdAt: 1, name: "(3) x" }] },
					approvals: undefined,
				}),
			),
		);
		expect(document.title).toBe("\uFF083\uFF09 x — AmazMe");

		renderer.render(
			buildWebView(
				input({
					directory: { sessions: [{ sessionId: "alpha-1", createdAt: 1, name: "(3) x" }] },
					approvals: { pending: [{ id: "a", tool: "bash", detail: "ls" }] },
				}),
			),
		);
		expect(document.title).toBe("(1) \uFF083\uFF09 x — AmazMe");
	});
});
