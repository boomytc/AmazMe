/** CI-only package fixture: no tag, source commit, or production version override. */
import { readFile, writeFile } from "node:fs/promises";
const packagePath = new URL("../packages/gui/package.json", import.meta.url);
const originalPath = new URL("../packages/gui/package.json.acceptance-original", import.meta.url);
if (process.argv.includes("--restore")) {
	await writeFile(packagePath, await readFile(originalPath));
} else {
	const text = await readFile(packagePath, "utf8");
	const pkg = JSON.parse(text);
	if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Acceptance requires a stable numeric package version");
	const [major, minor, patch] = pkg.version.split(".").map(Number);
	const baseline = patch > 0 ? [major, minor, patch - 1] : minor > 0 ? [major, minor - 1, 9] : major > 0 ? [major - 1, 9, 9] : undefined;
	if (!baseline) throw new Error("No lower test baseline exists");
	await writeFile(originalPath, text, { flag: "wx", mode: 0o600 });
	pkg.version = baseline.join(".");
	await writeFile(packagePath, JSON.stringify(pkg, null, "\t") + "\n");
}
