import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	copyIdentities,
	EN,
	localizeDocument,
	mcpExposureCopy,
	mcpScopeCopy,
	settingFieldCopy,
	settingGroupCopy,
	settingOptionCopy,
	settingScopeCopy,
	skillScopeCopy,
	thinkingLevelCopy,
	translate,
	ZH,
} from "../src/strings.ts";

const DOCUMENT = fileURLToPath(new URL("../src/page/index.html", import.meta.url));

const locales = ["en", "zh"] as const;

describe("message dictionaries", () => {
	test("carry the same keys in both languages", () => {
		expect(Object.keys(ZH).toSorted()).toEqual(Object.keys(EN).toSorted());
		expect(copyIdentities("zh").messages.toSorted()).toEqual(copyIdentities("en").messages.toSorted());
	});

	test("name every settings identity in both languages", () => {
		const en = copyIdentities("en");
		const zh = copyIdentities("zh");
		expect(zh.settingFields.toSorted()).toEqual(en.settingFields.toSorted());
		expect(zh.settingGroups.toSorted()).toEqual(en.settingGroups.toSorted());
		expect(Object.keys(zh.settingOptions).toSorted()).toEqual(Object.keys(en.settingOptions).toSorted());
		for (const id of Object.keys(en.settingOptions)) {
			expect(zh.settingOptions[id]?.toSorted()).toEqual(en.settingOptions[id]?.toSorted());
		}
	});

	test("carry no empty copy", () => {
		for (const locale of locales) {
			for (const [key, text] of Object.entries(locale === "zh" ? ZH : EN)) {
				expect(text.length, `${locale} ${key}`).toBeGreaterThan(0);
			}
			for (const identity of copyIdentities(locale).settingFields) {
				const copy = settingFieldCopy(locale, identity);
				expect(copy.label.length, `${locale} ${identity}`).toBeGreaterThan(0);
				expect(copy.description.length, `${locale} ${identity}`).toBeGreaterThan(0);
			}
		}
	});

	test("fills placeholders and leaves unknown ones alone", () => {
		expect(translate("en", "composer.placeholder", { id: "s-1" })).toBe("Send a task to s-1");
		expect(translate("zh", "composer.placeholder", { id: "s-1" })).toBe("给 s-1 发送任务");
		expect(translate("en", "status.retrying", { attempt: "2", error: "overloaded" })).toBe(
			"Retrying (attempt 2): overloaded",
		);
		expect(translate("en", "composer.placeholder")).toBe("Send a task to {id}");
	});

	test("names catalogues, scopes, and levels with a fallback to the identity", () => {
		expect(settingFieldCopy("zh", "compactionEnabled").label).toBe("自动压缩");
		expect(settingFieldCopy("zh", "compactionEnabled").description.length).toBeGreaterThan(0);
		expect(settingFieldCopy("zh", "futureField")).toEqual({ label: "futureField", description: "" });
		expect(settingGroupCopy("zh", "models-reasoning")).toBe("模型与推理");
		expect(settingGroupCopy("zh", "future-group")).toBe("future-group");
		expect(settingOptionCopy("zh", "cacheWarming", "idle")).toBe("回合之间也预热");
		expect(settingOptionCopy("zh", "cacheWarming", "future")).toBe("future");
		expect(settingScopeCopy("zh", "project")).toBe("项目");
		expect(skillScopeCopy("zh", "temporary")).toBe("临时");
		expect(mcpScopeCopy("zh", "extension")).toBe("扩展");
		expect(mcpExposureCopy("zh", "hidden")).toBe("隐藏");
		expect(thinkingLevelCopy("zh", "xhigh")).toBe("极高");
		expect(thinkingLevelCopy("en", "future")).toBe("Future");
	});
});

describe("served document localization", () => {
	test("replaces every marker of the shipped document in both languages", async () => {
		const html = await readFile(DOCUMENT, "utf8");
		for (const locale of locales) {
			const localized = localizeDocument(html, locale);
			expect(localized, `${locale} left a marker`).not.toContain("{{");
			expect(localized).toContain(`<html lang="${locale === "zh" ? "zh-Hans" : "en"}">`);
		}
	});

	test("keeps an unknown marker visible instead of blanking the document", () => {
		const localized = localizeDocument('<html lang="en"><p>{{nav.chat}}</p><p>{{future.key}}</p>', "zh");
		expect(localized).toContain("<p>对话</p>");
		expect(localized).toContain("<p>{{future.key}}</p>");
	});

	test("localizes the shell's own sentences, not only its labels", () => {
		const html = "<html lang=\"en\"><span>{{sidebar.waiting}}</span><span>{{header.noSession}}</span>";
		expect(localizeDocument(html, "zh")).toBe("<html lang=\"zh-Hans\"><span>正在等待宿主…</span><span>无会话</span>");
	});
});
