import type { MenuItemConstructorOptions } from "electron";
import type { Locale } from "@amazme/web/locale";
import { translate } from "@amazme/web/strings";

export interface TrayActions {
	readonly show: () => void;
	readonly quit: () => void;
}

/** The tray is the way back to a hidden window, so it has exactly those two actions. */
export function trayMenuTemplate(
	locale: Locale,
	actions: TrayActions,
	pendingApprovals = 0,
): MenuItemConstructorOptions[] {
	const open = translate(locale, "desktop.tray.open");
	return [
		{ label: pendingApprovals > 0 ? `${open} (${pendingApprovals})` : open, click: actions.show },
		{ type: "separator" },
		{ label: translate(locale, "desktop.tray.quit"), click: actions.quit },
	];
}
