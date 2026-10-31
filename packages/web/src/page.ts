import { PageRuntime } from "./app/page-runtime.ts";
import { mountPresentation } from "./react/mount.tsx";
import { Presentation } from "./react/state.ts";
import { isRecord } from "./transport/api.ts";

let page: PageRuntime | undefined;
function startWindow(): void {
	if (page) return;
	const boot: unknown = Reflect.get(globalThis, "__AMAZME_BOOT__");
	const app =
		isRecord(boot) &&
		isRecord(boot.app) &&
		typeof boot.app.name === "string" &&
		typeof boot.app.version === "string"
			? { name: boot.app.name, version: boot.app.version }
			: { name: "AmazMe", version: "" };
	const container = document.getElementById("amazme-root");
	if (!container) throw new Error("页面挂载入口不可用，请重新打开 AmazMe。");
	const presentation = new Presentation(app);
	const runtime = new PageRuntime(presentation);
	page = runtime;
	mountPresentation(presentation, container);
	void runtime
		.start()
		.catch((error) =>
			presentation.setConnection(
				error instanceof Error ? error.message : String(error),
				"error",
			),
		);
}
window.addEventListener("pagehide", () => {
	page?.dispose();
	page = undefined;
});
window.addEventListener("pageshow", (event) => {
	if (event.persisted) startWindow();
});
startWindow();
