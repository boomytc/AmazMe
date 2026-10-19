import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
const workflow = parse(source);
const job = workflow.jobs.release;
const SECRET_STEPS = {
	"Import the Developer ID certificate": ["MACOS_CERT_P12_BASE64", "MACOS_CERT_PASSWORD"],
	"Notarize and staple the DMG": ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY"],
};

test("release runs in the release environment and takes the team from a repository variable", () => {
	assert.equal(job.environment, "release");
	assert.equal(job.env.APPLE_TEAM_ID, "${{ vars.APPLE_TEAM_ID }}");
	assert.deepEqual(workflow.on, { push: { tags: ["v*"] } });
});

test("secrets reach only the signing and notarization steps", () => {
	assert.doesNotMatch(JSON.stringify(job.env ?? {}), /secrets\./);
	for (const step of job.steps) {
		const used = [...JSON.stringify(step).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]).sort();
		assert.deepEqual(used, SECRET_STEPS[step.name] ?? [], `step "${step.name ?? step.uses}" secrets`);
	}
	for (const name of Object.keys(SECRET_STEPS)) assert.ok(job.steps.some((step) => step.name === name), `missing step ${name}`);
});

test("signing material lives in RUNNER_TEMP, is private, and is always removed", () => {
	assert.doesNotMatch(source, /set -x|set -o xtrace|ACTIONS_STEP_DEBUG/);
	for (const name of Object.keys(SECRET_STEPS)) {
		const run = job.steps.find((step) => step.name === name).run;
		assert.match(run, /^umask 077$/m, `${name} must create files with mode 600`);
		for (const [, path] of run.matchAll(/>\s*"([^"]+)"/g)) assert.ok(path.startsWith("$RUNNER_TEMP/"), `${name} writes ${path} outside RUNNER_TEMP`);
	}
	const cleanup = job.steps.find((step) => step.name === "Remove signing material");
	assert.equal(cleanup.if, "always()");
	assert.match(cleanup.run, /security delete-keychain "\$RUNNER_TEMP\/amazme-signing\.keychain-db"/);
	assert.match(cleanup.run, /developer-id\.p12/);
	assert.match(cleanup.run, /asc-api-key\.p8/);
	const index = (name) => job.steps.findIndex((step) => step.name === name);
	assert.ok(index("Remove signing material") > index("Notarize and staple the DMG"));
	assert.ok(index("Publish GitHub Release") > index("Notarize and staple the DMG"));
});

test("the DMG is signed for the expected team before notarization", () => {
	const build = job.steps.find((step) => step.name === "Build, sign, and verify the DMG").run;
	assert.match(build, /--keychain "\$RUNNER_TEMP\/amazme-signing\.keychain-db" --team-id "\$APPLE_TEAM_ID"/);
	const notarize = job.steps.find((step) => step.name === "Notarize and staple the DMG").run;
	assert.match(notarize, /--team-id "\$APPLE_TEAM_ID"/);
});

test("pre-release tags publish as prereleases and never become latest", () => {
	const step = job.steps.find((candidate) => candidate.name === "Publish GitHub Release");
	const publish = (tag) => {
		const temp = mkdtempSync(join(tmpdir(), "amazme-release-publish-"));
		try {
			mkdirSync(join(temp, "AmazMe"));
			writeFileSync(join(temp, "AmazMe", "AmazMe.dmg"), "");
			mkdirSync(join(temp, "bin"));
			writeFileSync(join(temp, "bin", "gh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
			const result = spawnSync("bash", ["-e", "-c", step.run], {
				encoding: "utf8",
				env: { PATH: `${join(temp, "bin")}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_REF_NAME: tag },
			});
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim().split("\n");
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	};
	const rc = publish("v1.5.0-rc.1");
	assert.ok(rc.includes("--prerelease"));
	assert.ok(rc.includes("--latest=false"));
	const stable = publish("v1.5.0");
	assert.ok(stable.includes("--latest"));
	assert.ok(!stable.includes("--prerelease"));
});
