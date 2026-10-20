#!/usr/bin/env node
/**
 * Notarize, staple, and verify a Developer ID signed DMG, then rewrite its checksum.
 *
 * Credentials come from the environment (ASC_KEY_ID, ASC_ISSUER_ID) and a private key file.
 * notarytool output is never echoed: failures report only an allowlisted diagnostic or id/status.
 */
import { createHash, createPrivateKey } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertTeam, tool, writeChecksum } from "./macos-signing.mjs";

function argument(name) {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function required(value, name) {
	if (value === undefined || value.length === 0) throw new Error(`Missing ${name}`);
	return value;
}

/** Check an unencrypted PKCS#8 key locally; never include key text or parser errors in diagnostics. */
export function keyFileProblem(text) {
	if (text.includes("\\n")) return "contains literal \\n sequences instead of line breaks";
	if (!/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\s*$/.test(text.trim())) {
		return "must contain the original unencrypted PKCS#8 .p8 text";
	}
	try {
		createPrivateKey({ key: text, format: "pem", type: "pkcs8" });
	} catch {
		return "does not contain a readable PKCS#8 private key";
	}
	return undefined;
}

function readToolJson(output) {
	try {
		return JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1));
	} catch {
		return undefined;
	}
}

function submissionId(id) {
	return typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ? id : undefined;
}

/** Only an explicitly Invalid response with a validated UUID may request a diagnostic log. */
export function invalidSubmissionId(output) {
	const parsed = readToolJson(output);
	return parsed?.status === "Invalid" ? submissionId(parsed.id) : undefined;
}

/** Map error messages to fixed hints; paths, free text, ids, and arbitrary issue fields stay private. */
export function invalidLogDiagnostics(output) {
	const parsed = readToolJson(output);
	const hints = new Set();
	if (Array.isArray(parsed?.issues)) {
		for (const issue of parsed.issues) {
			if (issue?.severity !== "error" || typeof issue.message !== "string") continue;
			if (/not signed|invalid signature|signature.*(?:invalid|not valid)/i.test(issue.message)) hints.add("Notarization issue: check the Developer ID signature");
			if (/hardened runtime/i.test(issue.message)) hints.add("Notarization issue: check hardened runtime");
			if (/timestamp/i.test(issue.message)) hints.add("Notarization issue: check the secure timestamp");
			if (/entitlement/i.test(issue.message)) hints.add("Notarization issue: check signing entitlements");
		}
	}
	return hints.size === 0 ? ["Notarization log has no recognized issue (raw output withheld)"] : [...hints];
}

/** Classify output without copying arbitrary tool text, credentials, paths, or response bodies. */
export function submissionFailureMessage(output, parsed) {
	const jsonCode = [parsed?.statusCode, parsed?.code, parsed?.status,
		...(Array.isArray(parsed?.errors) ? parsed.errors.slice(0, 16).map(error => error?.status) : [])]
		.find(value => (typeof value === "number" || typeof value === "string") && /^(401|403|429|5\d{2})$/.test(String(value)));
	const safeJsonCode = (typeof jsonCode === "number" || typeof jsonCode === "string") && /^(401|403|429|5\d{2})$/.test(String(jsonCode)) ? String(jsonCode) : undefined;
	const http = /\bHTTP(?:\s+status(?:\s+code)?)?\s*[:=]?\s*["']?(401|403|429|5\d{2})(?!\d)/i.exec(output)?.[1] ?? safeJsonCode;
	if (http === "401") return "Notarization submit failed (HTTP 401: check App Store Connect credentials)";
	if (http === "403") return "Notarization submit failed (HTTP 403: check App Store Connect permissions and agreements)";
	if (http === "429") return "Notarization submit failed (HTTP 429: service rate limit)";
	if (http !== undefined) return `Notarization submit failed (HTTP ${http}: Apple service error)`;
	if (/\b(?:authentication|authorization) (?:failed|error)\b|\bunauthorized\b/i.test(output)) return "Notarization submit failed (authentication error; check App Store Connect credentials and access)";
	if (/timed out|timeout|NSURLErrorTimedOut/i.test(output)) return "Notarization submit failed (network timeout; submission outcome unknown)";
	if (/could not resolve host|cannot find host|NSURLErrorCannotFindHost/i.test(output)) return "Notarization submit failed (DNS resolution error)";
	if (/SSL|TLS|certificate verification failed/i.test(output)) return "Notarization submit failed (TLS connection error)";
	return "Notarization submit failed (unclassified tool error; raw output withheld)";
}

/** A history read never submits an archive. Only normalized diagnostics and a bounded exit code escape. */
export function historyFailureMessage(error) {
	const output = typeof error?.output === "string" ? error.output : "";
	const localHint = new Map([["ENOENT", "notarytool executable unavailable"], ["EACCES", "local tool execution permission denied"], ["EPERM", "local tool execution permission denied"], ["ENOBUFS", "tool output exceeded safe buffer"], ["ETIMEDOUT", "history query timed out"]]).get(error?.toolErrorCode);
	const diagnostic = localHint ? `Notarization history query failed (${localHint}; no archive submitted)` : submissionFailureMessage(output, readToolJson(output)).replace(/^Notarization submit failed /, "Notarization history query failed ");
	const exit = Number.isInteger(error?.exitCode) && error.exitCode > 0 && error.exitCode <= 255 ? ` (notarytool exit ${error.exitCode})` : "";
	const signal = ["SIGABRT", "SIGBUS", "SIGSEGV", "SIGKILL", "SIGTERM"].includes(error?.signal) ? ` (notarytool signal ${error.signal})` : "";
	return `History check: ${diagnostic}${exit}${signal}`;
}

/** Parse a submission or classify a failure; never echo unvalidated response fields. */
export function parseSubmission(output, commandSucceeded = true) {
	const parsed = readToolJson(output);
	const id = submissionId(parsed?.id);
	const status = ["Accepted", "Invalid", "In Progress", "Rejected"].includes(parsed?.status) ? parsed.status : undefined;
	if (status === "Accepted" && id !== undefined && commandSucceeded) return { id, status };
	if (status !== undefined && status !== "Accepted") throw new Error(`Notarization ${status} for submission ${id ?? "(unknown)"}`);
	throw new Error(submissionFailureMessage(output, parsed));
}

/** History never proves byte identity by filename alone. Pending/unknown matches block resubmission. */
export function matchingHistory(output, filename) {
	const parsed = readToolJson(output);
	if (!Array.isArray(parsed?.history)) throw new Error("Notarization history is unavailable (raw output withheld)");
	return parsed.history.filter(row => row?.name === filename).map(row => {
		const id = submissionId(row.id);
		if (!id || !["Accepted", "Invalid", "Rejected", "In Progress"].includes(row.status)) throw new Error("Matching notarization history is ambiguous; inspect the existing submission before retrying");
		return { id, status: row.status };
	});
}

export function logMatchesArchive(output, digest) {
	const parsed = readToolJson(output);
	return typeof parsed?.sha256 === "string" && /^[a-f0-9]{64}$/i.test(parsed.sha256) && parsed.sha256.toLowerCase() === digest;
}

async function priorSubmission(image, auth) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(image)) hash.update(chunk);
	const digest = hash.digest("hex");
	let history;
	try { history = tool("xcrun", ["notarytool", "history", ...auth, "--output-format", "json"]); }
	catch (error) { throw new Error(historyFailureMessage(error)); }
	for (const row of matchingHistory(history, basename(image))) {
		if (row.status === "In Progress") throw new Error(`Notarization In Progress for submission ${row.id}; inspect it before retrying`);
		let log;
		try { log = tool("xcrun", ["notarytool", "log", row.id, ...auth]); }
		catch { throw new Error(`Cannot establish archive identity for submission ${row.id}; inspect it before retrying`); }
		if (!logMatchesArchive(log, digest)) {
			const parsed = readToolJson(log);
			if (typeof parsed?.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(parsed.sha256)) throw new Error(`Cannot establish archive identity for submission ${row.id}; inspect it before retrying`);
			continue;
		}
		if (row.status !== "Accepted") throw new Error(`Notarization ${row.status} for submission ${row.id}; identical archive will not be resubmitted`);
		return row;
	}
	return undefined;
}

function step(name, command, args) {
	try {
		return tool(command, args);
	} catch (error) {
		throw new Error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function verifyMountedApp(image, teamId) {
	const mounted = await mkdtemp(join(tmpdir(), "amazme-notarized-"));
	try {
		step("Mount", "hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mounted, image]);
		const app = join(mounted, "AmazMe.app");
		step("App signature check", "codesign", ["--verify", "--deep", "--strict", app]);
		step("App Gatekeeper check", "spctl", ["--assess", "--type", "execute", app]);
		assertTeam(app, teamId);
	} finally {
		try {
			tool("hdiutil", ["detach", mounted, "-force"]);
		} finally {
			await rm(mounted, { recursive: true, force: true });
		}
	}
}

async function main() {
	if (process.platform !== "darwin") throw new Error("Notarization runs on macOS only");
	const historyOnly = process.argv.includes("--history-only");
	if (historyOnly && process.argv.includes("--dmg")) throw new Error("History-only mode cannot accept an archive");
	const image = historyOnly ? undefined : resolve(required(argument("--dmg"), "--dmg"));
	const key = resolve(required(argument("--key"), "--key"));
	const teamId = historyOnly ? undefined : required(argument("--team-id"), "--team-id");
	const keyId = required(process.env.ASC_KEY_ID, "ASC_KEY_ID");
	const issuer = required(process.env.ASC_ISSUER_ID, "ASC_ISSUER_ID");
	if (image !== undefined && !existsSync(image)) throw new Error(`No DMG at ${image}`);
	if (!existsSync(key)) throw new Error("App Store Connect key file is missing");
	let keyText;
	try {
		keyText = readFileSync(key, "utf8");
	} catch {
		throw new Error("App Store Connect key file could not be read");
	}
	const problem = keyFileProblem(keyText);
	if (problem !== undefined) throw new Error(`ASC_PRIVATE_KEY ${problem}`);

	const auth = ["--key", key, "--key-id", keyId, "--issuer", issuer];
	if (historyOnly) {
		let output;
		try { output = tool("xcrun", ["notarytool", "history", ...auth, "--output-format", "json"]); }
		catch (error) { throw new Error(historyFailureMessage(error)); }
		if (!Array.isArray(readToolJson(output)?.history)) throw new Error("Notarization history response is unavailable (raw output withheld; no archive submitted)");
		console.log("Notarization history query succeeded; no archive submitted.");
		return;
	}
	assertTeam(image, teamId);
	const existing = await priorSubmission(image, auth);
	let output;
	let commandSucceeded = true;
	try {
		output = existing ? JSON.stringify(existing) : tool("xcrun", ["notarytool", "submit", image, ...auth, "--wait", "--output-format", "json"]);
	} catch (error) {
		commandSucceeded = false;
		output = typeof error?.output === "string" ? error.output : "";
	}
	let submission;
	try {
		submission = parseSubmission(output, commandSucceeded);
	} catch (error) {
		const id = invalidSubmissionId(output);
		if (id !== undefined) {
			try {
				const log = tool("xcrun", ["notarytool", "log", id, "--key", key, "--key-id", keyId, "--issuer", issuer]);
				for (const hint of invalidLogDiagnostics(log)) console.error(hint);
			} catch {
				console.error("Notarization log unavailable (raw output withheld)");
			}
		}
		throw error;
	}
	console.log(`Notarization ${submission.status} for submission ${submission.id}`);

	step("Staple", "xcrun", ["stapler", "staple", image]);
	step("Staple validation", "xcrun", ["stapler", "validate", image]);
	step("DMG signature check", "codesign", ["--verify", "--deep", "--strict", image]);
	step("DMG Gatekeeper check", "spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", image]);
	assertTeam(image, teamId);
	await verifyMountedApp(image, teamId);
	console.log(`Stapled and verified, team ${teamId}`);
	console.log(`SHA256 ${await writeChecksum(image)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

