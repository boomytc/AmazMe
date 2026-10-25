/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { collectPageElements, createRenderer } from "../src/render.ts";
import { translate } from "../src/strings.ts";
import { failureView } from "../src/view.ts";

beforeEach(() => {
	const html = readFileSync(join(process.cwd(), "src/page/index.html"), "utf8");
	document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"))
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
});

test("startup status lives on the persistent brand mark, not the main header", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	renderer.render(failureView("zh", ""));
	expect(elements.connection.hidden).toBe(true);
	expect(elements.connectionStatus.closest(".app-rail")).not.toBeNull();
	expect(elements.connectionStatus.dataset.state).toBe("connecting");
	expect(elements.connectionStatusText.textContent).toBe(translate("zh", "connection.starting"));
	expect(elements.connectionStatus.querySelector(".connection-tooltip-name")?.textContent).toBe("AmazMe");
	expect(document.querySelector(".brand-name")).toBeNull();
	expect(elements.connectionStatus.getAttribute("tabindex")).toBe("0");
	expect(elements.connectionStatus.getAttribute("aria-describedby")).toBe(elements.connectionStatusText.id);
	expect(elements.connectionStatus.getAttribute("aria-live")).toBe("polite");
	expect(elements.connectionStatus.querySelector(".connection-dot")?.getAttribute("aria-hidden")).toBe("true");
});

test("connection transitions retain the logo and full localized hover diagnostics", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	const logo = elements.connectionStatus.querySelector(".pixel-logo");
	const dot = elements.connectionStatus.querySelector(".connection-dot");
	const error = "socket closed during synchronization";
	for (const state of ["connecting", "connected", "disconnected"] as const) {
		const key = state === "disconnected" ? "connection.disconnected"
			: state === "connected" ? "connection.connected" : "connection.connecting";
		renderer.setConnectionState((locale) => translate(locale, key, { error }), state);
		for (const locale of ["en", "zh"] as const) {
			renderer.render(failureView(locale, ""));
			expect(elements.connection.hidden).toBe(true);
			expect(elements.connection.textContent).toBe("");
			expect(elements.connectionStatus.dataset.state).toBe(state);
			expect(elements.connectionStatusText.textContent).toBe(translate(locale, key, { error }));
			expect(elements.connectionStatus.querySelector(".pixel-logo")).toBe(logo);
			expect(elements.connectionStatus.querySelector(".connection-dot")).toBe(dot);
		}
	}
});

test("action failures remain visible without falsely marking the host disconnected", () => {
	const elements = collectPageElements();
	const renderer = createRenderer(elements);
	renderer.setConnectionState((locale) => translate(locale, "connection.connected"), "connected");
	renderer.setConnection("Request rejected", "error");
	expect(elements.connection.hidden).toBe(false);
	expect(elements.connection.textContent).toBe("Request rejected");
	expect(elements.connectionStatus.dataset.state).toBe("connected");
	expect(elements.connectionStatusText.textContent).toBe(translate("en", "connection.connected"));

	renderer.setConnectionState((locale) => translate(locale, "connection.connecting"), "connecting");
	expect(elements.connection.hidden).toBe(true);
	expect(elements.connection.textContent).toBe("");
	expect(elements.connection.hasAttribute("title")).toBe(false);
	expect(elements.connection.hasAttribute("aria-label")).toBe(false);
});

test("attach failure keeps short copy and full accessible diagnostics across locale changes", () => {
	const renderer = createRenderer(collectPageElements());
	const error = "transport closed while synchronizing a long session path";
	renderer.render(failureView("en", ""));
	renderer.setConnection(
		(locale) => translate(locale, "page.attachFailed", { error }),
		"error",
		(locale) => translate(locale, "page.attachFailedShort"),
	);
	const connection = document.getElementById("connection");
	for (const locale of ["en", "zh"] as const) {
		renderer.render(failureView(locale, ""));
		expect(connection?.textContent).toBe(translate(locale, "page.attachFailedShort"));
		expect(connection?.title).toBe(translate(locale, "page.attachFailed", { error }));
		expect(connection?.getAttribute("aria-label")).toBe(connection?.title);
		expect(connection?.hidden).toBe(false);
		expect(connection?.querySelector(".connection-dot")).toBeNull();
	}
});
