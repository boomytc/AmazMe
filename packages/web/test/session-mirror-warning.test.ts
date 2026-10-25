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

test("mirror conflicts remain visible outside the transcript and do not replace connection diagnostics", () => {
	const renderer = createRenderer(collectPageElements());
	const warning = { path: "/fixture/session.jsonl", detail: "terminal file changed externally" };
	renderer.setConnection("connected", "state");
	renderer.render({ ...failureView("zh", ""), mirrorWarning: warning });
	const banner = document.getElementById("session-warning");
	expect(banner?.hidden).toBe(false);
	expect(banner?.getAttribute("role")).toBe("alert");
	expect(banner?.textContent).toBe(translate("zh", "page.mirrorWarning", warning));
	expect(document.querySelector(".header")?.contains(banner)).toBe(false);
	expect(document.getElementById("connection")?.textContent).toBe("connected");
	renderer.render({ ...failureView("en", ""), mirrorWarning: warning });
	expect(banner?.textContent).toBe(translate("en", "page.mirrorWarning", warning));
	renderer.render(failureView("en", ""));
	expect(banner?.hidden).toBe(true);
});
