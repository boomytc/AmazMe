import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const text = readFileSync(new URL("../.github/workflows/notary-history.yml", import.meta.url), "utf8");
const workflow = parse(text), job = workflow.jobs.history;
test("history diagnostics use approved tag source and existing environment without write permissions", () => {
	assert.deepEqual(workflow.on, { workflow_dispatch: null });
	assert.deepEqual(workflow.permissions, { contents: "read" }); assert.equal(job.environment, "release");
	assert.equal(job.steps[0].uses, "actions/checkout@v5"); assert.equal(job.steps[0].with, undefined);
	assert.match(job.steps[1].run, /GITHUB_REF_TYPE.*tag/); assert.match(job.steps[1].run, /vnotary-history-\*/);
	assert.doesNotMatch(text, /workflow_dispatch:[\s\S]*inputs:|--dmg|notarytool submit|gh release|git (?:tag|push)|set -x|ACTIONS_STEP_DEBUG/);
});
test("the read-only probe has a single private key step and unconditional cleanup", () => {
	for (const step of job.steps) {
		const names = [...JSON.stringify(step).matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]).sort();
		assert.deepEqual(names, step.name === "Query history without submitting an archive" ? ["ASC_ISSUER_ID", "ASC_KEY_ID", "ASC_PRIVATE_KEY"] : []);
	}
	const environment = job.steps.find(step => step.name === "Record notarytool environment");
	assert.match(environment.run, /xcrun notarytool --version/); assert.equal(environment.env, undefined);
	const probe = job.steps.find(step => step.name === "Query history without submitting an archive");
	assert.match(probe.run, /^umask 077$/m); assert.match(probe.run, /--history-only --key "\$RUNNER_TEMP\/asc-api-key.p8"/);
	assert.equal(job.steps.at(-1).if, "always()"); assert.match(job.steps.at(-1).run, /rm -f "\$RUNNER_TEMP\/asc-api-key.p8"/);
});
