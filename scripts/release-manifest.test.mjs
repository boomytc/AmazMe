import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildManifest } from "./release-manifest.mjs";

const script = new URL("./release-manifest.mjs", import.meta.url).pathname;
const DIGEST = "c".repeat(64);
const NAME = "AmazMe-1.5.0-macos-arm64.dmg";

test("lists each installer with its release download URL and sha256", () => {
	assert.deepEqual(buildManifest({ tag: "v1.5.0", repository: "boomytc/AmazMe", installers: [{ name: NAME, digest: DIGEST, published: `${DIGEST}  ${NAME}\n` }] }), {
		version: "1.5.0",
		tag: "v1.5.0",
		assets: [{ name: NAME, url: `https://github.com/boomytc/AmazMe/releases/download/v1.5.0/${NAME}`, sha256: DIGEST }],
	});
});

test("refuses a manifest whose installer does not match its published .sha256", () => {
	const build = (published) => buildManifest({ tag: "v1.5.0", repository: "boomytc/AmazMe", installers: [{ name: NAME, digest: DIGEST, published }] });
	assert.throws(() => build(`${"d".repeat(64)}  ${NAME}\n`), /does not match/);
	assert.throws(() => build(`${DIGEST}  other.dmg\n`), /does not match/);
	assert.throws(() => buildManifest({ tag: "nightly", repository: "boomytc/AmazMe", installers: [] }), /not a release tag/);
	assert.throws(() => buildManifest({ tag: "v1.5.0", repository: "boomytc/AmazMe", installers: [] }), /no installers/);
});

test("the CLI hashes the downloaded installers", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "amazme-manifest-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, NAME), "dmg bytes");
	const digest = createHash("sha256").update("dmg bytes").digest("hex");
	writeFileSync(join(dir, `${NAME}.sha256`), `${digest}  ${NAME}\n`);
	const out = join(dir, "latest.json");
	execFileSync(process.execPath, [script, "v1.5.0", "boomytc/AmazMe", dir, out]);
	assert.equal(JSON.parse(readFileSync(out, "utf8")).assets[0].sha256, digest);
	writeFileSync(join(dir, NAME), "tampered");
	assert.throws(() => execFileSync(process.execPath, [script, "v1.5.0", "boomytc/AmazMe", dir, out], { stdio: "pipe" }));
});
