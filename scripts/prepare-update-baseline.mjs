/** CI-only package fixture: no tag, source commit, or production version override. */
import { readFile, unlink, writeFile } from "node:fs/promises";
const packagePath = new URL("../packages/gui/package.json", import.meta.url);
const originalPath = new URL("../packages/gui/package.json.acceptance-original", import.meta.url);
const lockPath = new URL("../package-lock.json", import.meta.url);
const lockOriginalPath = new URL("../package-lock.json.acceptance-original", import.meta.url);
if (process.argv.includes("--restore")) {
	await writeFile(packagePath, await readFile(originalPath));
	await writeFile(lockPath, await readFile(lockOriginalPath));
	await unlink(originalPath); await unlink(lockOriginalPath);
} else {
	const text = await readFile(packagePath, "utf8");
	const pkg = JSON.parse(text);
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(pkg.version);
	if (!match) throw new Error("Acceptance requires a numeric SemVer core");
	const [major, minor, patch] = match.slice(1).map(Number);
	const baseline = patch > 0 ? [major, minor, patch - 1] : minor > 0 ? [major, minor - 1, 9] : major > 0 ? [major - 1, 9, 9] : undefined;
	if (!baseline) throw new Error("No lower test baseline exists");
	const lockText = await readFile(lockPath, "utf8"), lock = JSON.parse(lockText);
	if (lock.packages?.["packages/gui"]?.version !== pkg.version) throw new Error("GUI package and source lock disagree before acceptance");
	await writeFile(originalPath, text, { flag: "wx", mode: 0o600 });
	await writeFile(lockOriginalPath, lockText, { flag: "wx", mode: 0o600 });
	pkg.version = baseline.join(".");
	lock.packages["packages/gui"].version = pkg.version;
	await writeFile(packagePath, JSON.stringify(pkg, null, "\t") + "\n");
	await writeFile(lockPath, JSON.stringify(lock, null, "\t") + "\n");
}
