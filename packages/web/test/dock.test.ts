import { describe, expect, test } from "vitest";
import {
	TERMINAL_RUN_ACTION,
	TERMINAL_STOP_ACTION,
	WORKSPACE_OPEN_ACTION,
	WORKSPACE_READ_ACTION,
	WORKSPACE_RELOAD_ACTION,
} from "../src/actions.ts";
import { dockTabs, dockView, filesPanel, terminalPanel, workspaceSize } from "../src/dock.ts";
import type { TerminalStateLike, WorkspaceStateLike } from "../src/dock.ts";

const LISTING: WorkspaceStateLike = {
	cwd: "/workspace/AmazMe",
	view: {
		kind: "listing",
		path: ".",
		parent: null,
		entries: [
			{ name: "src", kind: "dir", size: 0 },
			{ name: "README.md", kind: "file", size: 2048 },
			{ name: "logo.png", kind: "file", size: 2_097_152 },
		],
	},
};

const TERMINAL: TerminalStateLike = {
	status: "done",
	command: "echo hi",
	exitCode: 0,
	output: "hi\n",
	truncated: false,
	error: null,
};

describe("the session dock", () => {
	test("offers its tabs and remembers which one is open", () => {
		expect(dockTabs("en", "terminal")).toEqual([
			{ id: "files", label: "Files", active: false },
			{ id: "terminal", label: "Terminal", active: true },
		]);
		expect(dockView("zh", { open: true, tab: "terminal", cwd: "/w", workspace: undefined, terminal: undefined })).toMatchObject({
			open: true,
			toggle: { label: "会话工具", pressed: true },
		});
		// An unknown tab falls back to the first one rather than showing nothing.
		expect(dockView("en", { open: true, tab: "nope", cwd: "/w", workspace: LISTING, terminal: TERMINAL }).panel.id).toBe(
			"files",
		);
	});

	test("lists a directory with an action per entry and the way back up", () => {
		const panel = filesPanel("en", LISTING);
		const rows = panel.groups[0]?.rows ?? [];
		expect(rows.map((row) => [row.title, row.badges?.[0], row.value])).toEqual([
			["src", "directory", undefined],
			["README.md", undefined, "2 KB"],
			["logo.png", undefined, "2.0 MB"],
		]);
		expect(rows[0]?.actions?.[0]).toEqual({ id: WORKSPACE_OPEN_ACTION, label: "Open", tone: "default", data: "src" });
		expect(rows[1]?.actions?.[0]).toEqual({
			id: WORKSPACE_READ_ACTION,
			label: "Read",
			tone: "default",
			data: "README.md",
		});
		expect(panel.groups[0]?.actions?.[0]?.id).toBe(WORKSPACE_RELOAD_ACTION);
		// The working directory itself has no parent row; a subdirectory does.
		expect(rows.some((row) => row.id === "files:up")).toBe(false);
		const nested = filesPanel("en", {
			cwd: "/w",
			view: {
				kind: "listing",
				path: "src",
				parent: ".",
				entries: [{ name: "index.ts", kind: "file", size: 12 }],
			},
		});
		expect(nested.groups[0]?.rows[0]).toMatchObject({ id: "files:up", description: ".", title: "Up" });
		// An entry's action names the path it resolves to, not only its own name.
		expect(nested.groups[0]?.rows[1]?.actions?.[0]).toMatchObject({ id: WORKSPACE_READ_ACTION, data: "src/index.ts" });
	});

	test("shows a file's text, and says when it is not text or not there", () => {
		const text = filesPanel("en", {
			cwd: "/w",
			view: { kind: "text", path: "src/index.ts", text: "export const marker = 1;\n", truncated: false },
		});
		expect(text.title).toBe("src/index.ts");
		expect(text.texts?.[0]?.text).toContain("marker = 1");
		expect(text.groups[0]?.rows[0]?.actions?.[0]?.data).toBe("src");
		expect(
			filesPanel("en", { cwd: "/w", view: { kind: "text", path: "big.txt", text: "…", truncated: true } }).notices[0],
		).toEqual({ tone: "info", text: "Only the beginning of this text is shown." });

		expect(
			filesPanel("en", { cwd: "/w", view: { kind: "binary", path: "logo.png" } }).notices[0]?.text,
		).toContain("not text");
		expect(filesPanel("en", { cwd: "/w", view: { kind: "missing", path: "gone" } }).notices[0]?.text).toContain(
			"not there any more",
		);
		const denied = filesPanel("en", { cwd: "/w", view: { kind: "denied", path: "../etc", reason: "outside it" } });
		expect(denied.notices[0]).toEqual({ tone: "error", text: "outside it" });
		expect(denied.groups[0]?.rows[0]?.actions?.[0]?.data).toBe(".");
	});

	test("gives the terminal one command line, a run, a stop, and the buffer", () => {
		const panel = terminalPanel("en", { cwd: "/w", state: TERMINAL });
		expect(panel.description).toBe("/w · Finished with exit code 0");
		expect(panel.inputs?.[0]).toMatchObject({
			placeholder: "Run a command in the session's directory",
			submit: { id: TERMINAL_RUN_ACTION, label: "Run", disabled: false },
		});
		expect(panel.groups[0]?.actions?.[0]).toMatchObject({ id: TERMINAL_STOP_ACTION, label: "Stop", disabled: true });
		expect(panel.texts?.[0]?.text).toBe("hi\n");

		const running = terminalPanel("en", {
			cwd: "/w",
			state: { status: "running", command: "sleep 5", exitCode: null, output: "", truncated: false, error: null },
		});
		expect(running.description).toContain("Running sleep 5");
		expect(running.inputs?.[0]?.submit.disabled).toBe(true);
		expect(running.groups[0]?.actions?.[0]?.disabled).toBe(false);
		expect(running.texts?.[0]?.empty).toBe("No output yet.");

		const stopped = terminalPanel("en", {
			cwd: "/w",
			state: { status: "cancelled", command: "sleep 5", exitCode: null, output: "part", truncated: false, error: null },
		});
		expect(stopped.description).toContain("Stopped");
		expect(
			terminalPanel("en", {
				cwd: "/w",
				state: { status: "done", command: "x", exitCode: 2, output: "", truncated: true, error: "boom" },
			}).notices[0]?.text,
		).toContain("only the beginning".replace("only", "Only"));
	});

	test("sizes a file the way a listing does", () => {
		expect(workspaceSize(512)).toBe("512 B");
		expect(workspaceSize(4096)).toBe("4 KB");
		expect(workspaceSize(3_145_728)).toBe("3.0 MB");
	});
});
