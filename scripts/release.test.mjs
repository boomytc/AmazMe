import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseArguments, releaseNotes, releasePlan, remoteTagCommit, staleReleaseNames } from "./release.mjs";

const HEAD = "a".repeat(40);
const ready = { branch: "main", dirty: false, head: HEAD, remoteHead: HEAD, version: "1.2.3", rootVersion: "1.2.3", localTag: undefined, remoteTag: undefined, releaseExists: false };

test("a clean, pushed main commit with a fresh version plans a new tag", () => {
	assert.deepEqual(releasePlan(ready), { tag: "v1.2.3", version: "1.2.3", prerelease: false, createTag: true, pushTag: true });
	assert.equal(releasePlan({ ...ready, version: "1.2.3-rc.1", rootVersion: "1.2.3-rc.1" }).prerelease, true);
});

test("repository state that could publish the wrong source is refused before any side effect", () => {
	for (const [state, message] of [
		[{ branch: "dev" }, /from main/],
		[{ branch: "" }, /detached HEAD/],
		[{ dirty: true }, /uncommitted/],
		[{ remoteHead: "b".repeat(40) }, /not origin\/main/],
		[{ rootVersion: "1.2.4" }, /differs from root/],
		[{ version: "1.2", rootVersion: "1.2" }, /Not a release version/],
		[{ version: "0.3.0", rootVersion: "0.3.0" }, /starts at 1\.0\.0/],
		[{ releaseExists: true }, /already exists/],
		[{ localTag: "b".repeat(40) }, /local tag v1\.2\.3 points at bbbbbbbb/],
		[{ remoteTag: "b".repeat(40) }, /remote tag v1\.2\.3 points at bbbbbbbb/],
	]) assert.throws(() => releasePlan({ ...ready, ...state }), message);
});

test("a tag already on HEAD without a release resumes publishing instead of re-tagging", () => {
	assert.deepEqual(releasePlan({ ...ready, localTag: HEAD, remoteTag: HEAD }), { tag: "v1.2.3", version: "1.2.3", prerelease: false, createTag: false, pushTag: false });
	assert.equal(releasePlan({ ...ready, localTag: HEAD }).pushTag, true);
});

test("prereleases never become latest; stable releases do", () => {
	const args = (prerelease) => releaseArguments({ tag: "v1.2.3", version: "1.2.3", prerelease, files: ["a.dmg", "a.dmg.sha256", "latest.json"], notes: "notes.md" });
	const rc = args(true), stable = args(false);
	assert.ok(rc.includes("--prerelease") && rc.includes("--latest=false") && !rc.includes("--latest"));
	assert.ok(stable.includes("--latest") && !stable.includes("--prerelease") && !stable.includes("--latest=false"));
	for (const list of [rc, stable]) {
		assert.ok(list.includes("--verify-tag"));
		assert.ok(["a.dmg", "a.dmg.sha256", "latest.json"].every((file) => list.includes(file)));
	}
});

test("remote tag lookup resolves annotated tags to their commit", () => {
	const tagObject = "c".repeat(40);
	assert.equal(remoteTagCommit(`${tagObject}\trefs/tags/v1.2.3\n${HEAD}\trefs/tags/v1.2.3^{}\n`, "v1.2.3"), HEAD);
	assert.equal(remoteTagCommit(`${HEAD}\trefs/tags/v1.2.3\n`, "v1.2.3"), HEAD);
	assert.equal(remoteTagCommit("", "v1.2.3"), undefined);
});

test("a local release build keeps only the version being built", () => {
	assert.deepEqual(staleReleaseNames(["v0.2.0", "v0.3.0", "v0.3.0-baseline", ".DS_Store"], "v0.3.0"), ["v0.2.0", "v0.3.0-baseline"]);
});

test("release notes verify the published DMG by name", () => {
	assert.match(releaseNotes("AmazMe-1.2.3-macos-arm64.dmg"), /shasum -a 256 -c AmazMe-1\.2\.3-macos-arm64\.dmg\.sha256/);
});
