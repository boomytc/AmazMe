import { globSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { createCodingAgentHarness } from "../src/harness.ts";

const TOOL_NAME = "submit_documentation_audit";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const docsRoot = resolve(repositoryRoot, "packages/coding-agent/docs");
const pages = globSync("**/*.md", { cwd: docsRoot })
	.map((path) => ({ path: path.replaceAll("\\", "/") }))
	.sort((left, right) => left.path.localeCompare(right.path));
const harness = createCodingAgentHarness({
	name: "documentation-page-audit",
	tools: ["read", "grep", "find", "ls", TOOL_NAME],
});

describeEval("Audit documentation against implementation", { harness }, (it) => {
	it.for(pages)("$path matches the implementation", async ({ path }, { run }) => {
		const documentationPath = resolve(docsRoot, path);
		const result = await run(`Audit this AmazMe documentation page against the repository implementation.

Documentation page: ${documentationPath}
Repository root: ${repositoryRoot}

Read the complete page and the relevant implementation. Report a mismatch only for a clear, user-visible contradiction between an explicit documentation claim and actual runtime behavior. Follow the runtime path; names, comments, types, isolated helpers, and tests are not sufficient evidence by themselves.

Missing internal detail, ambiguous wording, hypothetical misuse, and undocumented edge cases are not mismatches. If the evidence is not decisive, report inconclusive. Otherwise report match.

For a mismatch, quote the claim, cite the implementation path and symbol, and state the concrete behavior a user would observe.

Call ${TOOL_NAME} exactly once as your final action. Do not return prose.`);

		const auditCalls = toolCalls(result).filter((call) => call.name === TOOL_NAME);
		expect(auditCalls).toHaveLength(1);
		const auditCall = auditCalls[0];
		expect(auditCall?.status).toBe("ok");
		const explanation = auditCall?.arguments?.explanation;
		expect(auditCall?.arguments?.verdict, typeof explanation === "string" ? explanation : undefined).toBe("match");
	});
});
