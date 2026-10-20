import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const text = readFileSync(new URL("../.github/workflows/trusted-desktop.yml", import.meta.url), "utf8");
const workflow = parse(text), job = workflow.jobs.acceptance;
test("trusted acceptance is manual, read-only on repository contents and never publishes a tag or release", () => {
	assert.deepEqual(workflow.on, { workflow_dispatch: null });
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.equal(job.environment, "release");
	assert.doesNotMatch(text, /gh release (?:create|upload)|git (?:tag|push)|contents: write|workflow_dispatch:[\s\S]*inputs:/);
	assert.match(text, /actions\/upload-artifact@v4/);
	const guard = job.steps.find(step => step.name === "Require a fresh explicit dispatch").run;
	assert.match(guard, /GITHUB_REF_TYPE.*tag/);
	assert.match(guard, /GITHUB_REF_NAME.*v\$VERSION/);
});
test("real credentials reach only import/notarization; cleanup precedes acceptance and artifact upload", () => {
	const expected = {
		"Import the Developer ID certificate": ["MACOS_CERT_P12_BASE64", "MACOS_CERT_PASSWORD"],
		"Notarize and staple the DMG": ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY"],
		"Notarize the isolated baseline": ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY"],
	};
	for (const step of job.steps) {
		const secrets = [...JSON.stringify(step).matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]).sort();
		assert.deepEqual(secrets, expected[step.name] ?? []);
		if (secrets.length > 0) assert.match(step.run, /^umask 077$/m);
	}
	const index = name => job.steps.findIndex(step => step.name === name);
	const cleanup = job.steps[index("Remove signing material")];
	assert.equal(cleanup.if, "always()");
	assert.ok(index("Remove signing material") > index("Notarize the isolated baseline"));
	assert.ok(index("Validate manifest and isolated installation") > index("Remove signing material"));
	assert.doesNotMatch(text, /set -x|ACTIONS_STEP_DEBUG|NSAllowsArbitraryLoads|spctl --master-disable|xattr -d/);
});
