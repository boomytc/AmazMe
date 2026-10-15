import { describe, expect, test } from "vitest";
import { adjustedFontSizes, DEFAULT_TYPOGRAPHY } from "@amazme/web/typography";
import { InMemorySettingsStorage, SettingsManager, type SettingsScope } from "../src/core/settings-manager.ts";
import { applySetting, settingsErrors } from "../src/host/services/settings-provider.ts";

class FailingSettingsStorage extends InMemorySettingsStorage {
	readable = true;
	writable = true;
	loseReadAccessOnWrite = false;

	override withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		if (scope === "global" && !this.readable) throw new Error("EACCES: settings read refused");
		super.withLock(scope, current => {
			const next = fn(current);
			if (scope === "global" && next !== undefined && !this.writable) {
				if (this.loseReadAccessOnWrite) this.readable = false;
				throw new Error("EACCES: settings write refused");
			}
			return next;
		});
	}
}

function fixture() {
	const storage = new FailingSettingsStorage();
	storage.withLock("global", () => JSON.stringify({ typography: { codeFont: "Existing Mono" }, executionMode: "read-only" }));
	return { storage, manager: SettingsManager.fromStorage(storage) };
}

describe("settings write recovery", () => {
	test("rolls back a write-only failure and accepts one unchanged retry", async () => {
		const { storage, manager } = fixture();
		storage.writable = false;
		expect(await applySetting(manager, "textFont", "Georgia")).toMatchObject([{ message: "EACCES: settings write refused" }]);
		expect(manager.getTypography().textFont).toBe("");
		storage.writable = true;
		expect(await applySetting(manager, "textFont", "Georgia")).toEqual([]);
		expect(SettingsManager.fromStorage(storage).getTypography().textFont).toBe("Georgia");
	});

	test("refuses an unreadable edit without changing effective values and retries the same value once access returns", async () => {
		const { storage, manager } = fixture();
		storage.readable = false;
		storage.writable = false;
		expect(await applySetting(manager, "textFont", "Georgia")).toMatchObject([{ scope: "global", message: expect.stringContaining("read refused") }]);
		expect(manager.getTypography()).toEqual({ ...DEFAULT_TYPOGRAPHY, codeFont: "Existing Mono" });
		expect(() => manager.getExecutionMode()).toThrow("全局设置无法读取");

		storage.readable = true;
		storage.writable = true;
		expect(await applySetting(manager, "textFont", "Georgia")).toEqual([]);
		expect(SettingsManager.fromStorage(storage).getTypography()).toMatchObject({ textFont: "Georgia", codeFont: "Existing Mono" });
		expect(manager.getExecutionMode()).toBe("read-only");
	});

	test("restores the previous snapshot even when the write and rollback read both fail", async () => {
		const { storage, manager } = fixture();
		storage.writable = false;
		storage.loseReadAccessOnWrite = true;
		const errors = await applySetting(manager, "textFont", "Georgia");
		expect(errors.map(error => error.message)).toEqual(["EACCES: settings write refused", "EACCES: settings read refused"]);
		expect(manager.getTypography().textFont).toBe("");
		expect(manager.getTypography().codeFont).toBe("Existing Mono");

		storage.readable = true;
		storage.writable = true;
		expect(await applySetting(manager, "textFont", "Georgia")).toEqual([]);
		expect(SettingsManager.fromStorage(storage).getTypography().textFont).toBe("Georgia");
	});

	test("does not carry a failed font edit into a later unrelated successful write", async () => {
		const { storage, manager } = fixture();
		storage.writable = false;
		storage.loseReadAccessOnWrite = true;
		await applySetting(manager, "textFont", "Rejected Font");
		storage.readable = true;
		storage.writable = true;
		expect(await applySetting(manager, "codeSize", "15")).toEqual([]);
		expect(SettingsManager.fromStorage(storage).getTypography()).toEqual({ ...DEFAULT_TYPOGRAPHY, codeFont: "Existing Mono", codeSize: 15 });
	});

	test("computes relative font changes from the last persisted values after a failed change", async () => {
		const { storage, manager } = fixture();
		storage.writable = false;
		storage.loseReadAccessOnWrite = true;
		await manager.updateGlobalSettings(() => manager.setTypography(adjustedFontSizes(manager.getTypography(), "increase")));
		expect(settingsErrors(manager)).toHaveLength(2);
		expect(manager.getTypography().textSize).toBe(15);
		storage.readable = true;
		storage.writable = true;
		await manager.updateGlobalSettings(() => manager.setTypography(adjustedFontSizes(manager.getTypography(), "increase")));
		expect(settingsErrors(manager)).toEqual([]);
		expect(SettingsManager.fromStorage(storage).getTypography()).toMatchObject({ textSize: 16, codeSize: 14, terminalSize: 13 });
	});

	test("loads other processes' latest values before computing a global edit", async () => {
		const { storage, manager } = fixture();
		storage.withLock("global", () => JSON.stringify({ typography: { textSize: 19, codeFont: "External Mono" } }));
		await manager.updateGlobalSettings(() => manager.setTypography(adjustedFontSizes(manager.getTypography(), "increase")));
		expect(settingsErrors(manager)).toEqual([]);
		expect(manager.getTypography()).toMatchObject({ textSize: 20, codeFont: "External Mono" });
	});
});
