import { describe, expect, test } from "vitest";
import {
	deriveTranscriptRows,
	TranscriptModel,
	type TranscriptRow,
	type TranscriptRowSource,
} from "../src/modes/interactive/transcript-model.ts";

class Entry implements TranscriptRowSource {
	readonly transcriptRowId: string;
	readonly transcriptRowLabel?: string;
	readonly transcriptTurnStart?: boolean;
	expanded = false;
	opened = 0;
	constructor(id: string, options: { turnStart?: boolean; label?: string; text?: string } = {}) {
		this.transcriptRowId = id;
		this.transcriptTurnStart = options.turnStart;
		this.transcriptRowLabel = options.label;
		this.textValue = options.text;
	}
	private readonly textValue?: string;
	transcriptRowText = (): string | undefined => this.textValue;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	open(): void {
		this.opened++;
	}
}

const plain = (): object => ({ render: () => [] });

describe("deriveTranscriptRows", () => {
	test("numbers turns from prompt rows and skips components that do not opt in", () => {
		const first = new Entry("prompt-1", { turnStart: true });
		const answer = new Entry("answer-1");
		const second = new Entry("prompt-2", { turnStart: true, label: "second" });
		const rows = deriveTranscriptRows([plain(), first, answer, plain(), second], [], () => {});

		expect(rows.map((row) => row.id)).toEqual(["prompt-1", "answer-1", "prompt-2"]);
		expect(rows.map((row) => row.turnIndex)).toEqual([1, 1, 2]);
		expect(rows.map((row) => row.turnStart)).toEqual([true, false, true]);
	});

	test("keeps content before the first prompt in turn zero", () => {
		const banner = new Entry("banner");
		const prompt = new Entry("prompt", { turnStart: true });
		const rows = deriveTranscriptRows([banner, prompt], [], () => {});

		expect(rows[0]?.turnIndex).toBe(0);
		expect(rows[1]?.turnIndex).toBe(1);
	});

	test("accepts legacy rows that only expose fold or open", () => {
		const legacyFold = { setExpanded: () => {} };
		const legacyOpen = { open: () => {} };
		const rows = deriveTranscriptRows([legacyFold, legacyOpen], [], () => {});

		expect(rows.map((row) => row.id)).toEqual(["entry-0", "entry-1"]);
		expect(rows[0]).toMatchObject({ expandable: true, openable: false });
		expect(rows[1]).toMatchObject({ expandable: false, openable: true });
	});

	test("appends background work after child agents as process rows", () => {
		const opened: string[] = [];
		const rows = deriveTranscriptRows(
			[new Entry("p1", { turnStart: true })],
			[{ id: "child", description: "explore", transcript: ["step 1", "step 2"] }],
			() => {},
			[
				{
					transcriptRowId: "process-1",
					transcriptRowLabel: "command: sleep 5",
					transcriptRowText: () => "sleep 5\noutput",
					open: () => opened.push("process-1"),
				},
			],
		);

		expect(rows.map((row) => row.id)).toEqual(["p1", "child-child", "process-1"]);
		expect(rows[1]).toMatchObject({ kind: "child-agent", label: "explore" });
		expect(rows[1]?.text?.()).toBe("step 1\nstep 2");
		expect(rows[2]).toMatchObject({ kind: "process", label: "command: sleep 5", openable: true });
		expect(rows[2]?.text?.()).toBe("sleep 5\noutput");
		rows[2]?.open?.();
		expect(opened).toEqual(["process-1"]);
	});

	test("appends child agents in the final turn and routes open to the book", () => {
		const prompt = new Entry("prompt", { turnStart: true });
		const opened: string[] = [];
		const rows = deriveTranscriptRows([prompt], [{ id: "a" }, { id: "b" }], (id) => opened.push(id));

		expect(rows.map((row) => row.id)).toEqual(["prompt", "child-a", "child-b"]);
		expect(rows.map((row) => row.turnIndex)).toEqual([1, 1, 1]);
		expect(rows[1]?.kind).toBe("child-agent");
		rows[2]?.open?.();
		expect(opened).toEqual(["b"]);
	});
});

describe("TranscriptModel", () => {
	const rows = (): TranscriptRow[] =>
		deriveTranscriptRows(
			[
				new Entry("p1", { turnStart: true, text: "first prompt" }),
				new Entry("a1", { text: "first answer" }),
				new Entry("p2", { turnStart: true, text: "second prompt" }),
				new Entry("a2", { text: "second answer" }),
			],
			[],
			() => {},
		);

	test("moves by row and clamps at both ends", () => {
		const model = new TranscriptModel();
		model.setRows(rows());

		expect(model.selected?.id).toBe("p1");
		expect(model.move(-1)).toBeUndefined();
		expect(model.move(1)?.id).toBe("a1");
		expect(model.move(5)?.id).toBe("a2");
		expect(model.move(1)).toBeUndefined();
	});

	test("jumps between turn starts without revisiting the current turn", () => {
		const model = new TranscriptModel();
		model.setRows(rows());
		expect(model.turnStarts).toEqual([0, 2]);

		model.select(1);
		expect(model.moveTurn(1)?.id).toBe("p2");
		expect(model.moveTurn(1)).toBeUndefined();
		expect(model.moveTurn(-1)?.id).toBe("p1");
		expect(model.moveTurn(-1)).toBeUndefined();
	});

	test("keeps the selected row identity across re-derivation", () => {
		const model = new TranscriptModel();
		model.setRows(rows());
		model.select(2);

		model.setRows(rows());
		expect(model.selected?.id).toBe("p2");

		model.setRows(rows().slice(0, 2));
		expect(model.selected?.id).toBe("a1");

		model.setRows([]);
		expect(model.selected).toBeUndefined();
		expect(model.selectedIndex).toBe(0);
	});

	test("folds every expandable row and reports the count", () => {
		const sources = [new Entry("p1", { turnStart: true }), plain(), new Entry("a1")];
		const model = new TranscriptModel();
		model.setRows(deriveTranscriptRows(sources, [{ id: "child" }], () => {}));

		expect(model.expandAll(false)).toBe(2);
		expect((sources[0] as Entry).expanded).toBe(false);
		expect(model.setSelectedExpanded(true)).toBe(true);
		model.select(2);
		expect(model.setSelectedExpanded(true)).toBe(false);
	});

	test("pins rows the user folds and lets a bulk fold clear the pins", () => {
		const model = new TranscriptModel();
		model.setRows(rows());

		expect(model.setSelectedExpanded(true)).toBe(true);
		expect(model.pinnedChildIndexes()).toEqual([0]);
		model.select(1);
		expect(model.setSelectedExpanded(false)).toBe(true);
		expect(model.pinnedChildIndexes()).toEqual([0, 1]);

		expect(model.expandAll(true)).toBe(4);
		expect(model.pinnedChildIndexes()).toEqual([]);
	});

	test("drops pins for rows that leave the conversation", () => {
		const model = new TranscriptModel();
		model.setRows(rows());
		model.setSelectedExpanded(true);
		expect(model.pinnedChildIndexes()).toEqual([0]);

		model.setRows(rows().slice(1));
		expect(model.pinnedChildIndexes()).toEqual([]);
	});

	test("opens only openable rows", () => {
		let opened = 0;
		const model = new TranscriptModel();
		model.setRows(
			deriveTranscriptRows(
				[{ transcriptRowId: "fold-only", setExpanded: () => {} }],
				[{ id: "child" }],
				() => opened++,
			),
		);

		expect(model.openSelected()).toBe(false);
		model.select(1);
		expect(model.openSelected()).toBe(true);
		expect(opened).toBe(1);
	});

	test("searches labels and copyable text case-insensitively", () => {
		const model = new TranscriptModel();
		model.setRows(rows());

		expect(model.search("ANSWER")).toEqual([1, 3]);
		expect(model.search("second")).toEqual([2, 3]);
		expect(model.search("   ")).toEqual([]);
		expect(model.search("missing")).toEqual([]);
	});

	test("returns copyable text only when the row has some", () => {
		const model = new TranscriptModel();
		model.setRows(deriveTranscriptRows([new Entry("p1", { turnStart: true, text: "first prompt" })], [{ id: "child" }], () => {}));

		expect(model.selectedText()).toBe("first prompt");
		model.select(1);
		expect(model.selectedText()).toBeUndefined();
	});
});
