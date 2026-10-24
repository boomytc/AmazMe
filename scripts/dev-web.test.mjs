import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("the development web launcher reaches Python through the product CLI", async () => {
	const directory = await mkdtemp(join(tmpdir(), "amazme-dev-web-"));
	try {
		const result = await new Promise(resolve => execFile(process.execPath,
			[fileURLToPath(new URL("./dev-web.mjs", import.meta.url))],
			{timeout:20000, env:{...process.env, AMAZME_CODING_AGENT_DIR:join(directory,"agent"),
				AMAZME_PYTHON_BACKEND:join(directory,"missing-backend")}},
			(error, stdout, stderr) => resolve({error, stdout, stderr})));
		assert.ok(result.error);
		assert.match(result.stderr, /python_backend_missing/);
		assert.doesNotMatch(result.stderr, /old_web_host_removed/);
		assert.equal(result.stdout, "");
	} finally { await rm(directory, {recursive:true, force:true}); }
});
