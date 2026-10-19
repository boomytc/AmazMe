import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubmission } from "./notarize-macos.mjs";

test("only an Accepted submission passes, and failures carry just the id and status", () => {
	assert.deepEqual(parseSubmission('{"id":"abc","status":"Accepted","message":"ok"}'), { id: "abc", status: "Accepted" });
	assert.deepEqual(parseSubmission('Conducting pre-submission checks\n{"id":"abc","status":"Accepted"}\n'), { id: "abc", status: "Accepted" });
	assert.throws(() => parseSubmission('{"id":"abc","status":"Invalid","message":"issuer 69a6de7d-xxxx"}'), (error) => {
		assert.equal(error.message, "Notarization Invalid for submission abc");
		return true;
	});
	assert.throws(() => parseSubmission("Error: HTTP status code: 401"), /no readable result/);
});
