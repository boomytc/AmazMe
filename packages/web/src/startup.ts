import type { Locale } from "./locale.ts";
import { translate } from "./strings.ts";

export const STARTUP_PLACEHOLDER = "<!--amazme-startup-guard-->";

/** Standalone browser code, not a DOM dependency of the Node asset entry or a reflected/minified function. */
const GUARD = `(function(copy, scriptPath) {
	function isEntry(event) { return event.target instanceof HTMLScriptElement && event.target.id === "amazme-page-entry"; }
	function stop() {
		window.removeEventListener("error", onError, true);
		document.removeEventListener("load", onLoad, true);
	}
	function fail() {
		stop();
		var panel = document.createElement("section");
		panel.id = "startup-error";
		panel.className = "startup-error";
		panel.setAttribute("role", "alert");
		var title = document.createElement("h1");
		title.textContent = copy.title;
		var help = document.createElement("p");
		help.textContent = copy.help;
		var diagnostic = document.createElement("code");
		diagnostic.textContent = scriptPath;
		var retry = document.createElement("button");
		retry.id = "startup-retry";
		retry.type = "button";
		retry.textContent = copy.retry;
		retry.addEventListener("click", function() { window.location.reload(); });
		panel.append(title, help, diagnostic, retry);
		for (var child of document.body.children) if (child instanceof HTMLElement) child.inert = true;
		document.body.classList.add("startup-failed");
		document.body.append(panel);
		retry.focus();
	}
	function onError(event) {
		if (isEntry(event)) { fail(); return; }
		if (!(event instanceof ErrorEvent) || !event.filename) return;
		try {
			var source = new URL(event.filename, document.baseURI);
			var entry = new URL(scriptPath, document.baseURI);
			if (source.origin === entry.origin && source.pathname === entry.pathname) fail();
		} catch { /* Not an error from the page entry. */ }
	}
	function onLoad(event) { if (isEntry(event)) stop(); }
	window.addEventListener("error", onError, true);
	document.addEventListener("load", onLoad, true);
})`;

/** No imports, storage, network calls, or automatic reload in the injected guard. */
export function startupScript(locale: Locale, scriptPath: string): string {
	const copy = {
		title: translate(locale, "page.entryFailed"),
		help: translate(locale, "page.entryFailedHelp"),
		retry: translate(locale, "page.entryRetry"),
	};
	const safe = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
	return `${GUARD}(${safe(copy)}, ${safe(scriptPath)});`;
}
