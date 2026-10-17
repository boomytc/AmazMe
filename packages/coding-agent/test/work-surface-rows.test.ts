import { beforeAll, describe, expect, test } from "vitest";
import { ChildAgentBook } from "../src/core/child-session.ts";
import { ForegroundCommands } from "../src/core/foreground-commands.ts";
import { WorkSurface } from "../src/modes/interactive/work-surface.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function surface() {
	const opened: string[] = [];
	const book = new ChildAgentBook();
	const commands = new ForegroundCommands();
	const work = new WorkSurface(book, commands, {
		openProcess: (id) => opened.push(id),
		closeProcess: () => {},
	});
	return { work, commands, opened };
}

describe("WorkSurface transcript rows", () => {
	beforeAll(() => {
		initTheme("dark", false);
	});

	test("exposes background commands as transcript rows", () => {
		const { work, commands, opened } = surface();
		const task = commands.attach({ command: "sleep 5", pid: 1, detachAbort: () => {} });
		task.noteOutput("line one\nline two\n");

		const rows = work.transcriptRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.transcriptRowId).toBe("process-cmd-1");
		expect(rows[0]?.transcriptRowLabel).toBe("command: sleep 5");
		expect(rows[0]?.transcriptRowText?.()).toContain("line one");

		rows[0]?.open?.();
		expect(opened).toEqual(["cmd-1"]);
	});

	test("marks the highlighted process row without exceeding the width", () => {
		const { work, commands } = surface();
		const task = commands.attach({ command: "sleep 5", pid: 1, detachAbort: () => {} });
		task.noteOutput("output\n");

		work.highlightRowId = "process-cmd-1";
		const lines = work.render(40).map(stripAnsi);
		const marked = lines.find((line) => line.includes("Command running: sleep 5"));
		expect(marked?.startsWith("> ")).toBe(true);
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
	});
});
