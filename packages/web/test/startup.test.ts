import { Window } from "happy-dom";
import type { HTMLElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startupScript } from "../src/startup.ts";

const windows: Window[] = [];
afterEach(async () => { await Promise.all(windows.splice(0).map(window => window.happyDOM.close())); });

function setup(locale: "en" | "zh" = "en") {
	const window = new Window({ url: "http://127.0.0.1:19000/", settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: false } });
	windows.push(window);
	window.document.body.innerHTML = '<main id="main"><button>Existing UI</button></main><script id="amazme-page-entry" type="module" src="/page.js"></script>';
	window.eval(startupScript(locale, "/page.js"));
	const entry = window.document.getElementById("amazme-page-entry")!;
	return { window, entry };
}

describe("startup guard", () => {
	it.each(["en", "zh"] as const)("shows an accessible, localized resource failure with manual retry (%s)", locale => {
		const { window, entry } = setup(locale);
		const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
		entry.dispatchEvent(new window.Event("error"));
		const panel = window.document.querySelector("#startup-error")!;
		expect(panel.getAttribute("role")).toBe("alert");
		expect(panel.textContent).toContain(locale === "en" ? "AmazMe could not load" : "AmazMe 未能加载");
		expect(panel.textContent).toContain("/page.js");
		expect(window.document.getElementById("main")?.hasAttribute("inert")).toBe(true);
		expect(window.document.activeElement?.id).toBe("startup-retry");
		expect(reload).not.toHaveBeenCalled();
		(window.document.getElementById("startup-retry") as HTMLElement).click();
		expect(reload).toHaveBeenCalledOnce();
		entry.dispatchEvent(new window.Event("error"));
		expect(window.document.querySelectorAll("#startup-error")).toHaveLength(1);
	});
	it("catches entry syntax/evaluation errors without displaying untrusted error text", () => {
		const { window } = setup();
		window.dispatchEvent(new window.ErrorEvent("error", { filename: "http://127.0.0.1:19000/page.js", message: "<img src=x onerror=alert(1)> private details" }));
		expect(window.document.querySelector("#startup-error")).not.toBeNull();
		expect(window.document.body.textContent).not.toContain("private details");
		expect(window.document.querySelector("#startup-error img")).toBeNull();
	});
	it("ignores unrelated resources and stops intercepting errors after the entry loads", () => {
		const { window, entry } = setup();
		window.document.getElementById("main")!.dispatchEvent(new window.Event("error"));
		window.dispatchEvent(new window.ErrorEvent("error", { filename: "http://127.0.0.1:19000/other.js" }));
		window.dispatchEvent(new window.ErrorEvent("error", { filename: "http://example.invalid/page.js" }));
		expect(window.document.querySelector("#startup-error")).toBeNull();
		entry.dispatchEvent(new window.Event("load"));
		window.dispatchEvent(new window.ErrorEvent("error", { filename: "http://127.0.0.1:19000/page.js" }));
		expect(window.document.querySelector("#startup-error")).toBeNull();
		expect(window.document.getElementById("main")?.hasAttribute("inert")).toBe(false);
	});
	it("escapes script arguments even if the supplied path contains markup", () => {
		const script = startupScript("en", "</script><script>alert(1)</script>");
		expect(script).not.toContain("</script>");
	});
});
