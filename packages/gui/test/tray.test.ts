import { describe, expect, test, vi } from "vitest";
import { trayMenuTemplate } from "../src/tray.ts";

describe("trayMenuTemplate", () => {
	test("offers only the way back and the confirmed exit", () => {
		const show = vi.fn();
		const quit = vi.fn();
		const menu = trayMenuTemplate("zh", { show, quit });
		expect(menu.map((item) => item.label ?? item.type)).toEqual(["打开 AmazMe", "separator", "退出 AmazMe"]);
		(menu[0]?.click as (() => void) | undefined)?.();
		(menu[2]?.click as (() => void) | undefined)?.();
		expect(show).toHaveBeenCalledOnce();
		expect(quit).toHaveBeenCalledOnce();
	});

	test("uses the same English labels as the rest of the desktop shell", () => {
		const menu = trayMenuTemplate("en", { show: () => {}, quit: () => {} });
		expect(menu.map((item) => item.label).filter(Boolean)).toEqual(["Open AmazMe", "Quit AmazMe"]);
	});
});
