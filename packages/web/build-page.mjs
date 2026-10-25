import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { localizeDocument } from "./dist/strings.js";
import { STARTUP_PLACEHOLDER, startupScript } from "./dist/startup.js";

await build({ entryPoints: ["src/page.ts"], outfile: "dist/page/page.js", bundle: true, format: "esm", platform: "browser", target: "es2024", sourcemap: true });
const html = await readFile("src/page/index.html", "utf8");
for (const locale of ["en", "zh"]) {
	const document = localizeDocument(html, locale).replace(STARTUP_PLACEHOLDER, `<script>${startupScript(locale, "/page.js")}</script>`);
	await writeFile(`dist/page/index.${locale}.html`, document);
	if (locale === "zh") await writeFile("dist/page/index.html", document);
}
