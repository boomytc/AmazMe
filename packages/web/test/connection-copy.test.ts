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
		expect(connection?.querySelector(".connection-dot")?.getAttribute("aria-hidden")).toBe("true");
	}
});
