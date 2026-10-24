import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publishesToGitHub } from "./release.mjs";
import { credentialProblem, historyFailureMessage, invalidLogDiagnostics, invalidSubmissionId, keyFileProblem, logMatchesArchive, matchingHistory, notarizationAllowed, parseSubmission, productVersion, submissionFailureMessage } from "./notarize-macos.mjs";

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

test("history errors parse structured HTTP codes, distinguish the read operation and bound exit diagnostics", () => {
	for (const output of ['{"statusCode":401,"message":"SECRET /private/key.p8"}', '{"errors":[{"status":"401","code":"SECRET","detail":"/private/key.p8"}]}', 'HTTP status = "403" SECRET', 'HTTP 429 SECRET']) {
		const message = historyFailureMessage({ output, exitCode: 69 });
		assert.match(message, /history query failed \(HTTP (401|403|429)/);
		assert.match(message, /notarytool exit 69/);
		assert.doesNotMatch(message, /SECRET|private\/|submit failed/);
	}
	assert.match(historyFailureMessage({ output: "Authentication failed SECRET /private/key.p8", exitCode: 1 }), /history query failed \(authentication error;/);
	const timeout = historyFailureMessage({ output: "request timed out SECRET /private/key.p8", exitCode: 1 });
	assert.match(timeout, /query outcome unknown/); assert.doesNotMatch(timeout, /submission outcome|SECRET|private\//);
	for (const exitCode of [undefined, 0, -1, 256, 1.5, "69 SECRET"]) {
		assert.doesNotMatch(historyFailureMessage({ output: "SECRET /private/key.p8", exitCode }), /notarytool exit|SECRET|private\//);
	}
	assert.match(historyFailureMessage({ toolErrorCode: "ENOBUFS", message: "SECRET /private/key.p8" }), /tool output exceeded safe buffer/);
	assert.match(historyFailureMessage({ signal: "SIGBUS", output: "SECRET" }), /notarytool signal SIGBUS/);
	assert.doesNotMatch(historyFailureMessage({ toolErrorCode: "SECRET", signal: "SECRET", message: "SECRET /private/key.p8" }), /SECRET|private\//);
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

const UUID = "12345678-1234-1234-1234-123456789abc";
test("history is scoped by filename and byte identity is required to resume", () => {
	assert.deepEqual(matchingHistory(JSON.stringify({ history: [{ name: "other.dmg", id: "SECRET" }, { name: "AmazMe.dmg", id: UUID, status: "In Progress" }] }), "AmazMe.dmg"), [{ id: UUID, status: "In Progress" }]);
	assert.throws(() => matchingHistory("SECRET", "AmazMe.dmg"), /history is unavailable/);
	assert.throws(() => matchingHistory(JSON.stringify({ history: [{ name: "AmazMe.dmg", id: "SECRET", status: "Accepted" }] }), "AmazMe.dmg"), /ambiguous/);
	assert.equal(logMatchesArchive(JSON.stringify({ sha256: "a".repeat(64) }), "a".repeat(64)), true);
	assert.equal(logMatchesArchive(JSON.stringify({ sha256: "b".repeat(64) }), "a".repeat(64)), false);
});
// Disposable test key, generated locally without any App Store Connect account or credentials.
const PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("key preflight accepts real PKCS#8 text and rejects encoded or corrupt lookalikes", () => {
	assert.equal(keyFileProblem(PEM), undefined);
	assert.equal(keyFileProblem(PEM.replace(/\n/g, "\r\n")), undefined);
	assert.match(keyFileProblem(PEM.replace(/\n/g, "\\n")), /literal \\n/);
	assert.match(keyFileProblem(Buffer.from(PEM).toString("base64")), /original unencrypted PKCS#8/);
	assert.match(keyFileProblem("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"), /readable PKCS#8/);
	assert.match(keyFileProblem("-----BEGIN ENCRYPTED PRIVATE KEY-----\nSECRET\n-----END ENCRYPTED PRIVATE KEY-----\n"), /original unencrypted PKCS#8/);
	for (const [type, options] of [["rsa", { modulusLength: 2048 }], ["ed25519", {}], ["ec", { namedCurve: "secp384r1" }]]) {
		const other = generateKeyPairSync(type, options).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		assert.match(keyFileProblem(other), /EC P-256/);
	}
});

test("credential preflight reports issuer and key ID shape without echoing values", () => {
	assert.equal(credentialProblem("KEYID42ABC", UUID), undefined);
	assert.equal(credentialProblem("KEYID42ABC", UUID.toUpperCase()), undefined);
	for (const [keyId, issuer, expected] of [
		["KEYID42ABC", `${UUID}\n`, /ASC_ISSUER_ID has leading or trailing whitespace/],
		["KEYID42ABC", `${UUID}\r`, /ASC_ISSUER_ID has leading or trailing whitespace/],
		["KEYID42ABC", "ABCDE12345", /looks like a Key ID or Team ID/],
		["KEYID42ABC", `"${UUID}"`, /UUID format/],
		["KEYID42ABC", UUID.replace(/-/g, ""), /UUID format/],
		["KEYID42ABC ", UUID, /ASC_KEY_ID has leading or trailing whitespace/],
		["KEY-ID", UUID, /alphanumeric/],
	]) {
		const problem = credentialProblem(keyId, issuer);
		assert.match(problem, expected);
		assert.ok(!problem.includes(issuer.trim()) && !problem.includes(keyId.trim()));
	}
});

test("notarytool usage errors name only allowlisted options, never their values", () => {
	for (const [output, expected] of [
		[`Error: The value 'SECRET' is invalid for '--issuer <issuer>': SECRET must be a valid UUID`, /rejected --issuer; value withheld/],
		[`Error: The value '/private/key.p8' is invalid for '--key <key>': The file couldn’t be opened`, /rejected --key; value withheld/],
		["Error: Missing expected argument '--key-id <key-id>'", /rejected --key-id; value withheld/],
		["Error: App Store Connect API Key ID contains invalid characters: [\"SECRET\"]", /API Key ID format/],
		["Error: invalidASN1Object", /could not parse the private key/],
	]) {
		const message = historyFailureMessage({ output, exitCode: 64 });
		assert.match(message, expected); assert.match(message, /history query failed .*notarytool exit 64/);
		assert.doesNotMatch(message, /SECRET|private\/|key\.p8/);
	}
	assert.match(submissionFailureMessage("Error: Unknown option '--SECRET'"), /unclassified tool error/);
});

test("only Invalid submissions with a valid UUID can request a log", () => {
	assert.equal(invalidSubmissionId(JSON.stringify({ status: "Invalid", id: UUID })), UUID);
	for (const payload of [{ status: "Accepted", id: UUID }, { status: "Rejected", id: UUID }, { status: "Invalid", id: "SECRET /private/key.p8" }, { status: "Invalid" }]) {
		assert.equal(invalidSubmissionId(JSON.stringify(payload)), undefined);
	}
	assert.equal(invalidSubmissionId(`broken {"status":"Invalid","id":"${UUID}"`), undefined);
});

test("Invalid logs yield bounded fixed hints, never arbitrary messages, paths, or fields", () => {
	const diagnostics = invalidLogDiagnostics(JSON.stringify({
		issues: [
			{ severity: "error", message: "The binary is not signed with a valid Developer ID certificate. SECRET", path: "/private/key.p8" },
			{ severity: "error", message: "The executable does not have the hardened runtime enabled." },
			{ severity: "error", message: "The signature does not include a secure timestamp." },
			{ severity: "error", message: "Invalid entitlements: SECRET /private/key.p8" },
			{ severity: "error", message: "The secure timestamp is missing." },
			{ severity: "error", message: "SECRET /private/key.p8", code: "SECRET" },
		],
	}));
	assert.deepEqual(diagnostics, [
		"Notarization issue: check the Developer ID signature",
		"Notarization issue: check hardened runtime",
		"Notarization issue: check the secure timestamp",
		"Notarization issue: check signing entitlements",
	]);
	assert.doesNotMatch(diagnostics.join("\n"), /SECRET|private|key\.p8/);
	for (const output of ["SECRET {broken", "{}", '{"issues":["SECRET"]}', '{"issues":[{"severity":"warning","message":"timestamp SECRET"}]}']) {
		assert.deepEqual(invalidLogDiagnostics(output), ["Notarization log has no recognized issue (raw output withheld)"]);
	}
});

const script = join(dirname(fileURLToPath(import.meta.url)), "notarize-macos.mjs");
const FIXTURE_ISSUER = "87654321-4321-4321-4321-cba987654321";

function runWithFakeTools({ submitOutput = "", submitError = "", submitExit = 1, logOutput = "", logError = "", logExit = 0, historyOutput = '{"history":[]}', historyError = "", historyExit = 0, keyText = PEM, keyDirectory = false, historyOnly = false, archiveInHistory = false, keyId = "KEYID42", issuer = FIXTURE_ISSUER } = {}) {
	const temp = realpathSync(mkdtempSync(join(tmpdir(), "amazme-notary-test-")));
	try {
		const bin = join(temp, "bin");
		mkdirSync(bin);
		writeFileSync(join(temp, "AmazMe.dmg"), "fixture, never mounted");
		const key = join(temp, "fixture-private-key.p8");
		if (keyDirectory) mkdirSync(key);
		else writeFileSync(key, keyText);
		for (const [name, text] of Object.entries({ "submit.stdout": submitOutput, "submit.stderr": submitError, "log.stdout": logOutput, "log.stderr": logError, "history.stdout": historyOutput, "history.stderr": historyError })) writeFileSync(join(temp, name), text);
		writeFileSync(join(temp, "as-macos.mjs"), 'Object.defineProperty(process, "platform", { value: "darwin" });\n');
		writeFileSync(join(bin, "codesign"), '#!/bin/sh\nprintf "codesign\\n" >> "$FIXTURE/trace"\nprintf "TeamIdentifier=TEAM1\\n" >&2\n', { mode: 0o755 });
		writeFileSync(join(bin, "xcrun"), `#!/bin/sh
printf "xcrun:%s:%s\\n" "$1" "$2" >> "$FIXTURE/trace"
if [ "$1" = notarytool ] && [ "$2" = history ]; then
  /bin/cat "$FIXTURE/history.stdout"
  /bin/cat "$FIXTURE/history.stderr" >&2
  exit "$HISTORY_EXIT"
fi
if [ "$1" = notarytool ] && [ "$2" = submit ]; then
  /bin/cat "$FIXTURE/submit.stdout"
  /bin/cat "$FIXTURE/submit.stderr" >&2
  exit "$SUBMIT_EXIT"
fi
if [ "$1" = notarytool ] && [ "$2" = log ]; then
  /bin/cat "$FIXTURE/log.stdout"
  /bin/cat "$FIXTURE/log.stderr" >&2
  exit "$LOG_EXIT"
fi
printf "Unexpected fake tool action\\n" >&2
exit 97
`, { mode: 0o755 });
		for (const command of ["hdiutil", "spctl", "security"]) writeFileSync(join(bin, command), '#!/bin/sh\nprintf "Unexpected fake tool\\n" >&2\nexit 97\n', { mode: 0o755 });
		const mode = historyOnly ? ["--history-only", ...(archiveInHistory ? ["--dmg", join(temp, "AmazMe.dmg")] : [])] : ["--dmg", join(temp, "AmazMe.dmg"), "--team-id", "TEAM1"];
		const result = spawnSync(process.execPath, ["--import", pathToFileURL(join(temp, "as-macos.mjs")).href, script, ...mode, "--key", key], {
			encoding: "utf8",
			timeout: 5000,
			env: { PATH: bin, FIXTURE: temp, SUBMIT_EXIT: String(submitExit), LOG_EXIT: String(logExit), HISTORY_EXIT: String(historyExit), ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer },
		});
		assert.equal(result.error, undefined);
		const trace = existsSync(join(temp, "trace")) ? readFileSync(join(temp, "trace"), "utf8").trim().split("\n") : [];
		return { status: result.status, stdout: result.stdout, stderr: result.stderr, trace };
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

test("notarization uses the same 1.0.0 gate as GitHub release", () => {
	for (const version of ["0.3.4", "0.9.9", "1.0.0", "1.2.3", "1.0.0-rc.1", "not-a-version"]) {
		assert.equal(notarizationAllowed(version), publishesToGitHub(version));
	}
	assert.equal(productVersion(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

const versionAllowsNotarization = notarizationAllowed(productVersion());
const cliOptions = { skip: process.platform === "win32" || !versionAllowsNotarization };
const refusalOptions = { skip: process.platform === "win32" || versionAllowsNotarization };

test("below 1.0.0 the direct entry refuses before credentials or notarytool", refusalOptions, () => {
	const version = productVersion();
	for (const options of [
		{ historyOnly: true },
		{ historyOnly: true, archiveInHistory: true },
		{ keyDirectory: true },
		{ keyText: "not-a-key" },
		{ issuer: "not-a-uuid" },
		{},
	]) {
		const result = runWithFakeTools(options);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr.trim(), `Notarization starts at 1.0.0; ${version} is local use only`);
		assert.deepEqual(result.trace, []);
		assert.doesNotMatch(result.stderr, /KEYID42|BEGIN PRIVATE|fixture-private-key|notarytool/);
	}
});

test("history-only mode can only read history and never accepts an archive", cliOptions, () => {
	const success = runWithFakeTools({ historyOnly: true });
	assert.equal(success.status, 0);
	assert.equal(success.stdout.trim(), "Notarization history query succeeded; no archive submitted.");
	assert.deepEqual(success.trace, ["xcrun:notarytool:history"]);
	const failure = runWithFakeTools({ historyOnly: true, historyExit: 69, historyOutput: '{"code":401,"message":"SECRET /private/key.p8"}' });
	assert.equal(failure.status, 1); assert.match(failure.stderr, /history query failed.*HTTP 401/);
	assert.doesNotMatch(failure.stderr, /SECRET|private\/|key\.p8/); assert.deepEqual(failure.trace, ["xcrun:notarytool:history"]);
	const archive = runWithFakeTools({ historyOnly: true, archiveInHistory: true });
	assert.equal(archive.status, 1); assert.match(archive.stderr, /cannot accept an archive/); assert.deepEqual(archive.trace, []);
});

test("CLI history failures remain private and stop before submit, log, staple or mounting", cliOptions, () => {
	for (const fixture of [
		{ historyExit: 69, historyOutput: '{"code":401,"message":"SECRET KEYID42 /private/key.p8"}', expected: /HTTP 401/ },
		{ historyExit: 77, historyError: 'HTTP status = "403" SECRET KEYID42 /private/key.p8', expected: /HTTP 403/ },
		{ historyExit: 1, historyError: "SECRET KEYID42 /private/key.p8", expected: /unclassified tool error/ },
	]) {
		const result = runWithFakeTools(fixture);
		assert.equal(result.status, 1); assert.equal(result.stdout, "");
		assert.match(result.stderr, fixture.expected);
		assert.match(result.stderr, new RegExp(`notarytool exit ${fixture.historyExit}`));
		assert.doesNotMatch(result.stderr, /SECRET|KEYID42|87654321-4321|\/private\/|key\.p8/);
		assert.deepEqual(result.trace, ["codesign", "xcrun:notarytool:history"]);
	}
});

test("bad key text and unreadable key files stop before any external tool", cliOptions, () => {
	for (const keyText of [PEM.replace(/\n/g, "\\n"), "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"]) {
		const result = runWithFakeTools({ keyText });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /ASC_PRIVATE_KEY/);
		assert.doesNotMatch(result.stderr, /AAAA|BEGIN PRIVATE KEY|fixture-private-key/);
		assert.deepEqual(result.trace, []);
	}
	const unreadable = runWithFakeTools({ keyDirectory: true });
	assert.equal(unreadable.status, 1);
	assert.match(unreadable.stderr, /key file could not be read/);
	assert.doesNotMatch(unreadable.stderr, /fixture-private-key|EISDIR/);
	assert.deepEqual(unreadable.trace, []);
});

test("malformed issuer or key ID stops before any external tool, in both modes", cliOptions, () => {
	for (const historyOnly of [false, true]) {
		for (const [env, expected] of [[{ issuer: `${FIXTURE_ISSUER}\n` }, /ASC_ISSUER_ID has leading or trailing whitespace/], [{ issuer: "TEAMID1234" }, /looks like a Key ID or Team ID/], [{ keyId: "KEYID42 " }, /ASC_KEY_ID has leading/]]) {
			const result = runWithFakeTools({ historyOnly, ...env });
			assert.equal(result.status, 1); assert.match(result.stderr, expected);
			assert.doesNotMatch(result.stderr, /TEAMID1234|87654321-4321|KEYID42 /); assert.deepEqual(result.trace, []);
		}
	}
});

test("CLI Invalid diagnostics retain fixed hints without secret or path output", cliOptions, () => {
	const result = runWithFakeTools({
		submitOutput: JSON.stringify({ status: "Invalid", id: UUID }),
		logOutput: JSON.stringify({ issues: [{ severity: "error", message: `The binary is not signed KEYID42 ${FIXTURE_ISSUER} SECRET`, path: "/private/key.p8" }] }),
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /check the Developer ID signature/);
	assert.match(result.stderr, new RegExp(`Invalid for submission ${UUID}`));
	assert.doesNotMatch(result.stderr, /SECRET|KEYID42|87654321-4321|\/private\/|key\.p8/);
	assert.deepEqual(result.trace, ["codesign", "xcrun:notarytool:history", "xcrun:notarytool:submit", "xcrun:notarytool:log"]);
});

test("CLI log failures stay private and preserve the original Invalid result", cliOptions, () => {
	const result = runWithFakeTools({ submitOutput: JSON.stringify({ status: "Invalid", id: UUID }), logExit: 69, logError: "SECRET KEYID42 /private/key.p8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /log unavailable \(raw output withheld\)/);
	assert.match(result.stderr, /Notarization Invalid/);
	assert.doesNotMatch(result.stderr, /SECRET|KEYID42|\/private\/|key\.p8/);
});

test("CLI failures never staple or request logs for unvalidated or Accepted responses", cliOptions, () => {
	for (const options of [
		{ submitExit: 69, submitOutput: JSON.stringify({ status: "Accepted", id: UUID }) },
		{ submitOutput: JSON.stringify({ status: "Invalid", id: "KEYID42 /private/key.p8" }) },
		{ submitError: "HTTP status code: 401 SECRET KEYID42 /private/key.p8" },
	]) {
		const result = runWithFakeTools(options);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.doesNotMatch(result.stderr, /SECRET|KEYID42|\/private\/|key\.p8/);
		assert.deepEqual(result.trace, ["codesign", "xcrun:notarytool:history", "xcrun:notarytool:submit"]);
	}
});

