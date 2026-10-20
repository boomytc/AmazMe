import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubmission, submissionFailureMessage } from "./notarize-macos.mjs";

test("only an Accepted submission passes, and failures carry just the id and status", () => {
	assert.deepEqual(parseSubmission('{"id":"12345678-1234-1234-1234-123456789abc","status":"Accepted","message":"ok"}'), { id: "12345678-1234-1234-1234-123456789abc", status: "Accepted" });
	assert.deepEqual(parseSubmission('Conducting pre-submission checks\n{"id":"12345678-1234-1234-1234-123456789abc","status":"Accepted"}\n'), { id: "12345678-1234-1234-1234-123456789abc", status: "Accepted" });
	assert.throws(() => parseSubmission('{"id":"12345678-1234-1234-1234-123456789abc","status":"Invalid","message":"issuer 69a6de7d-xxxx"}'), (error) => {
		assert.equal(error.message, "Notarization Invalid for submission 12345678-1234-1234-1234-123456789abc");
		return true;
	});
	assert.throws(() => parseSubmission("Error: HTTP status code: 401"), /HTTP 401/);
});

test("submission failures expose only allowlisted HTTP diagnostics", () => {
	for (const [code, hint] of [[401, "credentials"], [403, "permissions and agreements"], [429, "rate limit"], [500, "Apple service error"], [503, "Apple service error"]]) {
		const output = submissionFailureMessage(`Error: HTTP status code: ${code}. private-key=SECRET issuer=PRIVATE /private/key.p8`);
		assert.match(output, new RegExp(`HTTP ${code}`));
		assert.ok(output.includes(hint));
		assert.doesNotMatch(output, /SECRET|PRIVATE|key\.p8/);
	}
});

test("network diagnostics do not claim an unknown submission was rejected", () => {
	assert.match(submissionFailureMessage("The request timed out: SECRET"), /network timeout; submission outcome unknown/);
	assert.match(submissionFailureMessage("Could not resolve host: PRIVATE"), /DNS resolution error/);
	assert.match(submissionFailureMessage("TLS handshake failed: SECRET"), /TLS connection error/);
});

test("unknown output, unsupported status codes, and private key text remain withheld", () => {
	for (const output of ["", "HTTP status code: 4010 SECRET", "HTTP status code: 400 SECRET", "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----", "issuer=PRIVATE key-id=SECRET /private/key.p8"]) {
		assert.equal(submissionFailureMessage(output), "Notarization submit failed (unclassified tool error; raw output withheld)");
	}
});

test("JSON errors and mixed malformed output retain safe diagnostics", () => {
	for (const output of ['{"code":401,"message":"SECRET"}', '{"statusCode":"403","detail":"SECRET"}', 'Error: HTTP status code: 401 {broken SECRET}', 'prefix {"code":503,"message":"SECRET"} suffix']) {
		assert.throws(() => parseSubmission(output, false), (error) => {
			assert.match(error.message, /HTTP (401|403|503)/);
			assert.doesNotMatch(error.message, /SECRET|broken/);
			return true;
		});
	}
});

test("submission fields are validated and never echoed arbitrarily", () => {
	for (const status of ["Invalid", "In Progress"]) {
		assert.throws(() => parseSubmission(JSON.stringify({ status, id: "SECRET", message: "PRIVATE" }), false), (error) => {
			assert.equal(error.message, `Notarization ${status} for submission (unknown)`);
			return true;
		});
	}
	for (const payload of [{ status: "SECRET", id: "PRIVATE" }, { status: "Accepted", id: "SECRET" }, { status: { credential: "SECRET" }, code: "SECRET" }]) {
		assert.throws(() => parseSubmission(JSON.stringify(payload)), (error) => {
			assert.equal(error.message, "Notarization submit failed (unclassified tool error; raw output withheld)");
			return true;
		});
	}
	assert.throws(() => parseSubmission('{"status":"Accepted","id":"12345678-1234-1234-1234-123456789abc"}', false), /submit failed/);
});

