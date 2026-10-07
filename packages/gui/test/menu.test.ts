import { describe, expect, test } from "vitest";
import { editMenuTemplate, type EditFlags } from "../src/menu.ts";

const enabled: EditFlags = {
	canUndo: true,
	canRedo: true,
	canCut: true,
	canCopy: true,
	canPaste: true,
	canSelectAll: true,
};

const disabled: EditFlags = {
	canUndo: false,
	canRedo: false,
	canCut: false,
	canCopy: false,
	canPaste: false,
	canSelectAll: false,
};

describe("editMenuTemplate", () => {
	test("an editable field gets the built-in edit roles, enabled from editFlags", () => {
		const flags: EditFlags = { ...enabled, canUndo: false, canPaste: false };
		const menu = editMenuTemplate({ isEditable: true, selectionText: "", editFlags: flags }, "zh");
		expect(menu.map((item) => item.role)).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
		expect(menu.map((item) => item.enabled)).toEqual([false, true, true, true, false, true]);
		expect(menu.map((item) => item.label)).toEqual(["撤销", "重做", "剪切", "复制", "粘贴", "全选"]);
	});

	test("English labels come from the same catalog", () => {
		const menu = editMenuTemplate({ isEditable: true, selectionText: "kept", editFlags: enabled }, "en");
		expect(menu.map((item) => item.label)).toEqual(["Undo", "Redo", "Cut", "Copy", "Paste", "Select All"]);
		expect(menu.every((item) => item.enabled)).toBe(true);
	});

	test("a disabled editable field still lists every action", () => {
		const menu = editMenuTemplate({ isEditable: true, selectionText: "", editFlags: disabled }, "en");
		expect(menu).toHaveLength(6);
		expect(menu.every((item) => item.enabled === false)).toBe(true);
	});

	test("a non-editable selection offers copy alone", () => {
		const menu = editMenuTemplate(
			{ isEditable: false, selectionText: "hello", editFlags: { ...disabled, canCopy: true } },
			"zh",
		);
		expect(menu).toEqual([{ role: "copy", label: "复制", enabled: true }]);
	});

	test("copy stays disabled when the renderer cannot copy the selection", () => {
		const menu = editMenuTemplate(
			{ isEditable: false, selectionText: " ", editFlags: disabled },
			"en",
		);
		expect(menu).toEqual([{ role: "copy", label: "Copy", enabled: false }]);
	});

	test("nothing selected and nothing editable yields no menu", () => {
		expect(editMenuTemplate({ isEditable: false, selectionText: "", editFlags: enabled }, "zh")).toEqual([]);
	});
});
