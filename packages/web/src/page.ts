import { PageRuntime } from "./app/page-runtime.ts";
import { applyDesktopChrome } from "./desktop.ts";
import { errorMessageCopy } from "./errors.ts";
import { mountPresentation } from "./react/mount.tsx";
import { Presentation } from "./react/state.ts";
import { isRecord } from "./transport/api.ts";

/** The language the document already announced; boot copy has no settings round-trip. */
function bootLocale(): "zh" | "en" {
	return document.documentElement.lang === "en" ? "en" : "zh";
}

let page: PageRuntime | undefined;
function startWindow(): void {
	if (page) return;
	// Before React paints: the titlebar reserves the native window controls only inside a shell.
	applyDesktopChrome(document.documentElement);
	const boot: unknown = Reflect.get(globalThis, "__AMAZME_BOOT__");
	const app =
		isRecord(boot) &&
		isRecord(boot.app) &&
		typeof boot.app.name === "string"
			? { name: boot.app.name }
			: { name: "AmazMe" };
	const container = document.getElementById("amazme-root");
	if (!container) throw new Error("页面挂载入口不可用，请重新打开 AmazMe。");
	const presentation = new Presentation(app);
	const runtime = new PageRuntime(presentation);
	page = runtime;
	mountPresentation(presentation, container);
	void runtime.start().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		/* Startup is the page's own failure: it stays until the reader dismisses it. */
		presentation.showToast(errorMessageCopy(bootLocale(), message), "error", true);
	});
}
window.addEventListener("pagehide", () => {
	page?.dispose();
	page = undefined;
});
window.addEventListener("pageshow", (event) => {
	if (event.persisted) startWindow();
});
startWindow();
